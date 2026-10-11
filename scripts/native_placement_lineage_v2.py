"""Offline selected native-event association v2, never complete gameplay proof.

Execution uses original w2 bit1, including observed flags2. Signed native frame
fields admit -1. Original spawn return is linked to subsequent registration of
the same actor under the same debit call. Delayed insertion and queued command
object associations are explicitly temporal; cloning is never asserted.

Consumes frozen match-observer-v2 and hand-provenance-v1 JSON reports. No game
code, guest access, file mutation, or native invocation occurs here. Sources are
not authenticated by this parser. A passing chain is observed temporal/parent
provenance in those receipts, not proof of complete hand ownership or causality.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import re


class EvidenceError(ValueError):
    pass


def integer(value, low, high, name):
    if type(value) is not int or not low <= value <= high:
        raise EvidenceError('Invalid exact integer: ' + name)
    return value


def pointer(value, name, nonzero=False):
    if type(value) is not str or not re.fullmatch(r'0x[0-9a-f]+', value):
        raise EvidenceError('Invalid pointer: ' + name)
    result = int(value, 16)
    if result >= 1 << 64 or value != hex(result) or (nonzero and not result):
        raise EvidenceError('Invalid canonical pointer: ' + name)
    return result


def descriptor(value):
    if type(value) is not str or not re.fullmatch('[0-9a-f]{40}', value):
        raise EvidenceError('Invalid 20-byte descriptor')
    return value


def identity(value):
    keys = ('runner_pointer', 'primary_context_pointer', 'primary_level_pointer')
    if type(value) is not dict or set(value) != set(keys):
        raise EvidenceError('Invalid primary identity')
    for key in keys:
        pointer(value[key], key, True)
    return value


def validate_report(report, schema):
    if type(report) is not dict or report.get('schema') != schema:
        raise EvidenceError('Wrong observer schema')
    ident = identity(report.get('identity'))
    if identity(report.get('identity_at_report')) != ident:
        raise EvidenceError('Changed primary identity')
    if report.get('error') is not None or report.get('pending_event_ids') != []:
        raise EvidenceError('Observer error or incomplete native calls')
    rows = report.get('events')
    if type(rows) is not list or len(rows) > 1000000:
        raise EvidenceError('Invalid bounded event list')
    allowed = ({'command153_execute','command_queue_insert','native_card_debit_and_deploy',
                'native_character_spawn','native_actor_registration_request','native_actor_enqueue',
                'native_actor_register','native_level_end_commit'} if schema == 'native-match-observer-v2'
               else {'native_hand_slot_get','native_live_hand_descriptor_build',
                     'native_command153_descriptor_set','command153_execute'})
    previous_frame = 0
    for index, row in enumerate(rows):
        if type(row) is not dict or integer(row.get('id'), 0, 1000000, 'event id') != index:
            raise EvidenceError('Event IDs must be contiguous and in entry order')
        if row.get('event') not in allowed:
            raise EvidenceError('Unsupported event label')
        expected_va = {'command153_execute':0xd77504,'command_queue_insert':0xd75a44,
                       'native_card_debit_and_deploy':0xf9ea68,'native_character_spawn':0xd35ab4,
                       'native_actor_registration_request':0xf8c294,'native_actor_enqueue':0xf8c2bc,
                       'native_actor_register':0xf8c50c,'native_level_end_commit':0xd3e360,
                       'native_hand_slot_get':0xf9dd98,'native_live_hand_descriptor_build':0xe80bbc,
                       'native_command153_descriptor_set':0xd77c8c}[row['event']]
        if row.get('entry_elf_va') != hex(expected_va):
            raise EvidenceError('Event label differs from pinned native entry')
        if row.get('identity_at_entry') != ident:
            raise EvidenceError('Event primary identity differs')
        if type(row.get('returned')) is not bool or not row['returned']:
            raise EvidenceError('Native return not observed')
        parent = row.get('observed_parent_id')
        if parent is not None:
            integer(parent, 0, index - 1, 'parent event id')
        args = row.get('entry_args')
        if type(args) is not list or len(args) != 8:
            raise EvidenceError('Expected eight original entry arguments')
        for item in args:
            pointer(item, 'entry argument')
        for key in ('entry_elf_va','entry_lr','entry_sp','return_x0'):
            pointer(row.get(key), key)
        frame = integer(row.get('primary_frame_at_entry'), 0, 0xffffffff, 'frame')
        if frame < previous_frame:
            raise EvidenceError('Primary frame regressed; association unavailable')
        previous_frame = frame
    counts = report.get('counts')
    if type(counts) is not dict or counts != dict(Counter(r['event'] for r in rows)):
        raise EvidenceError('Counts differ from actual event records')
    for value in counts.values():
        integer(value, 0, 1000000, 'event count')
    return ident, rows


def ancestors(row, rows):
    result = []
    parent = row['observed_parent_id']
    while parent is not None:
        result.append(rows[parent])
        parent = rows[parent]['observed_parent_id']
    return result


def command_key(row):
    integer(row.get('flags_u32'), 0, 0xffffffff, 'command flags')
    integer(row.get('native_return_signed32'), -0x80000000, 0x7fffffff, 'command result')
    if row['flags_u32'] != (int(row['entry_args'][2], 16) & 0xffffffff):
        raise EvidenceError('Flags disagree with native w2')
    expected = int(row['return_x0'], 16) & 0xffffffff
    expected = expected if expected < 0x80000000 else expected - 0x100000000
    if expected != row['native_return_signed32']:
        raise EvidenceError('Native command return disagrees with x0')
    descriptor(row.get('descriptor_raw'))
    for key in ('authoritative_frame','client_frame'):
        integer(row.get(key), -0x80000000, 0x7fffffff, key)
    coordinates = row.get('coordinates')
    if type(coordinates) is not list or len(coordinates) != 2:
        raise EvidenceError('Invalid command coordinates')
    for value in coordinates:
        integer(value, -0x80000000, 0x7fffffff, 'coordinate')
    keys = ('entry_elf_va','entry_lr','entry_sp','entry_args','identity_at_entry',
            'primary_frame_at_entry','context_kind','flags_u32','authoritative_frame',
            'client_frame','coordinates','descriptor_raw','return_x0','native_return_signed32')
    return {key: row[key] for key in keys}


def metadata(value, command):
    if type(value) is not dict:
        raise EvidenceError('Missing command sequence/account receipt')
    if pointer(value.get('command_pointer'), 'metadata command', True) != int(command['entry_args'][0], 16):
        raise EvidenceError('Command metadata pointer differs')
    integer(value.get('sequence_signed32'), -0x80000000, 0x7fffffff, 'sequence')
    account = value.get('account_words_u32')
    if type(account) is not list or len(account) != 2:
        raise EvidenceError('Invalid account words')
    for item in account:
        integer(item, 0, 0xffffffff, 'account word')
    if descriptor(value.get('descriptor_raw')) != command['descriptor_raw']:
        raise EvidenceError('Command metadata descriptor differs')
    return value


def membership(value, row):
    if type(value) is not dict:
        raise EvidenceError('Missing world membership')
    if value.get('world_pointer') != row['entry_args'][0] or value.get('actor_pointer') != row['entry_args'][1]:
        raise EvidenceError('Membership actor/world differs from native args')
    pointer(value['world_pointer'], 'world', True)
    pointer(value['actor_pointer'], 'actor', True)
    count = integer(value.get('count_signed32'), 0, 65536, 'live actor count')
    pointer(value.get('vector_pointer'), 'live vector', bool(count))
    integer(value.get('actor_occurrences'), 0, count, 'actor occurrences')
    integer(value.get('native_actor_id_u32'), 0, 0xffffffff, 'native actor ID')
    return value


def live_insertion(row):
    if row['event'] != 'native_actor_register' or row.get('context_kind') != 'primary':
        return False
    flag = integer(row.get('insert_argument_u32'), 0, 0xffffffff, 'native insert argument')
    if flag != (int(row['entry_args'][3], 16) & 0xffffffff):
        raise EvidenceError('Insert argument differs from native w3')
    before = membership(row.get('membership_before'), row)
    after = membership(row.get('membership_after'), row)
    proven = (flag != 0 and before['actor_occurrences'] == 0 and after['actor_occurrences'] == 1
              and after['count_signed32'] == before['count_signed32'] + 1)
    if type(row.get('new_live_membership_observed')) is not bool or row['new_live_membership_observed'] != proven:
        raise EvidenceError('Derived insertion label disagrees with raw membership')
    return proven


def hand_chain(command, rows):
    before = metadata(command.get('command_metadata_before'), command)
    after = metadata(command.get('command_metadata_after'), command)
    if before != after:
        allowed_sequence = (command['flags_u32'] & 2) == 0 and command['native_return_signed32'] == 0
        if not allowed_sequence or {k:v for k,v in before.items() if k!='sequence_signed32'} != {k:v for k,v in after.items() if k!='sequence_signed32'}:
            return None, 'Unexpected command metadata changed during execution'
    setters = [r for r in rows[:command['id']] if r['event'] == 'native_command153_descriptor_set'
               and r.get('command_pointer') == command['entry_args'][0]]
    if not setters:
        return None, 'No earlier native descriptor setter for this command'
    setter = setters[-1]
    if setter['entry_args'][0] != setter.get('command_pointer') or setter['entry_args'][1] != setter.get('source_descriptor_pointer'):
        raise EvidenceError('Setter fields differ from original arguments')
    raw = descriptor(setter.get('source_descriptor_raw'))
    if descriptor(setter.get('command_descriptor_raw_after')) != raw or setter.get('observed_descriptor_copy_matches') is not True:
        return None, 'Native setter did not preserve descriptor bytes'
    if raw != command['descriptor_raw']:
        return None, 'Most recent setter differs from executed descriptor'
    builders = [r for r in rows[:setter['id']] if r['event'] == 'native_live_hand_descriptor_build'
                and r.get('native_output_pointer') == setter['source_descriptor_pointer']]
    if not builders:
        return None, 'No earlier native builder at setter input pointer'
    builder = builders[-1]
    pointer(builder.get('native_output_pointer'), 'saved x8 output', True)
    if builder.get('hand_card_pointer') != builder['entry_args'][0] or builder.get('king_pointer') != builder['entry_args'][1]:
        raise EvidenceError('Builder fields differ from original arguments')
    pointer(builder['hand_card_pointer'], 'hand card', True)
    pointer(builder['king_pointer'], 'king', True)
    integer(builder.get('builder_option_u32'), 0, 0xffffffff, 'builder option')
    if builder['builder_option_u32'] != int(builder['entry_args'][2], 16) & 0xffffffff:
        raise EvidenceError('Builder option disagrees with w2')
    if descriptor(builder.get('native_output_descriptor_raw')) != raw:
        return None, 'Latest output at native builder pointer differs'
    getters = [r for r in rows[:builder['id']] if r['event'] == 'native_hand_slot_get'
               and r.get('king_pointer') == builder['king_pointer']]
    if not getters:
        return None, 'No earlier native hand getter for builder king'
    getter = getters[-1]
    if getter.get('king_pointer') != getter['entry_args'][0]:
        raise EvidenceError('Getter king differs from original x0')
    slot = integer(getter.get('hand_slot_signed32'), -0x80000000, 0x7fffffff, 'hand slot')
    expected = int(getter['entry_args'][1], 16) & 0xffffffff
    expected = expected if expected < 0x80000000 else expected - 0x100000000
    if slot != expected or getter.get('returned_hand_card_pointer') != getter['return_x0']:
        raise EvidenceError('Getter fields differ from original native values')
    if getter['return_x0'] != builder['hand_card_pointer']:
        return None, 'Most recent getter returned a different hand card'
    if getter in ancestors(builder, rows) or builder in ancestors(setter, rows) or setter in ancestors(command, rows):
        return None, 'Required earlier native function was still pending at dependent entry'
    return {'getter_id':getter['id'],'builder_id':builder['id'],'setter_id':setter['id'],
            'king_pointer':builder['king_pointer'],'hand_card_pointer':builder['hand_card_pointer'],
            'hand_slot_signed32':slot,'descriptor_raw':raw,'sequence_signed32':after['sequence_signed32'],'sequence_before_signed32':before['sequence_signed32'],
            'account_words_u32':before['account_words_u32']}, None


def analyze(main_report, hand_report):
    ident, main = validate_report(main_report, 'native-match-observer-v2')
    hand_ident, hand = validate_report(hand_report, 'native-hand-provenance-v1')
    if ident != hand_ident:
        raise EvidenceError('Observers belong to different primary matches')
    mc = [r for r in main if r['event'] == 'command153_execute']
    hc = [r for r in hand if r['event'] == 'command153_execute']
    if len(mc) != len(hc) or [command_key(r) for r in mc] != [command_key(r) for r in hc]:
        raise EvidenceError('Observers do not contain the exact same command occurrence stream')
    command_pairs = list(zip(mc,hc))
    main_for_hand = {h['id']:m for m,h in command_pairs}
    ancestry = {}
    for row in main:
        parent=row['observed_parent_id']
        ancestry[row['id']] = [] if parent is None else [parent]+ancestry[parent]
    insertions = [r for r in main if live_insertion(r)]
    all_debits = [r for r in main if r['event']=='native_card_debit_and_deploy']
    all_spawns = [r for r in main if r['event']=='native_character_spawn']
    all_origins = [r for r in main if r['event'] in ('native_actor_registration_request','native_actor_enqueue','native_actor_register')]

    def associate_hand(cmd, handcmd):
        current=metadata(handcmd.get('command_metadata_before'),handcmd)
        after=metadata(handcmd.get('command_metadata_after'),handcmd)
        if current != after:
            return None,'Execution changed sequence/account/descriptor metadata'
        direct,why=hand_chain(handcmd,hand)
        if direct is not None:
            direct.update(source_hand_command_id=handcmd['id'],source_main_command_id=cmd['id'],
                          command_object_relation='same observed pointer',native_clone_transition_observed=False)
            sources=[direct]
        else:
            sources=[]
            for previous in hc:
                if previous['id']>=handcmd['id']:break
                if previous.get('context_kind')!='primary' or previous['flags_u32']&2 or previous['native_return_signed32']!=0:
                    continue
                old=metadata(previous.get('command_metadata_after'),previous)
                if any(previous[k]!=handcmd[k] for k in ('authoritative_frame','client_frame','coordinates','descriptor_raw')):
                    continue
                if any(old[k]!=current[k] for k in ('sequence_signed32','account_words_u32','descriptor_raw')):
                    continue
                source,reason=hand_chain(previous,hand)
                if source is None:continue
                prior_main=main_for_hand[previous['id']]
                queues=[q for q in main[prior_main['id']+1:cmd['id']]
                        if q['event']=='command_queue_insert' and q.get('context_kind')=='primary'
                        and q.get('command_pointer')==previous['entry_args'][0]]
                accepted=[]
                for q in queues:
                    pointer(q.get('command_pointer'),'queued command',True)
                    before=integer(q.get('queue_count_before'),0,0x7fffffff,'queue count before')
                    after_count=integer(q.get('queue_count_after'),0,0x7fffffff,'queue count after')
                    if after_count==before+1:accepted.append(q)
                if len(accepted)!=1:continue
                source.update(source_hand_command_id=previous['id'],source_main_command_id=prior_main['id'],
                              primary_queue_event_id=accepted[0]['id'],
                              validation_command_pointer=previous['entry_args'][0],
                              executed_command_pointer=handcmd['entry_args'][0],
                              command_object_relation='matching descriptor/account/sequence/frames/coordinates across queued and executed objects; temporal association',
                              native_clone_transition_observed=False)
                sources.append(source)
        if len(sources)!=1:
            return None,'Require one unambiguous direct or queued descriptor-source association'
        source=sources[0]
        # Original execute itself resolves the current card. Record that native
        # getter independently, not only a much earlier pointer/byte match.
        getters=[r for r in hand if r['event']=='native_hand_slot_get'
                 and handcmd in ancestors(r,hand) and r.get('king_pointer')==source['king_pointer']
                 and r.get('returned_hand_card_pointer')==source['hand_card_pointer']]
        if source['source_hand_command_id']!=handcmd['id'] and len(getters)!=1:
            return None,'Queued-object association lacks one matching original execution hand getter'
        for getter in getters:
            if getter['return_x0']!=getter['returned_hand_card_pointer'] or getter['entry_args'][0]!=getter['king_pointer']:
                raise EvidenceError('Execution getter contradicts original register observations')
        source['execution_hand_getter_ids']=[r['id'] for r in getters]
        return source,None

    candidates,chains=[],[]
    for cmd,handcmd in command_pairs:
        if cmd.get('context_kind')!='primary' or not(cmd['flags_u32']&2) or cmd['native_return_signed32']!=0:
            continue
        if cmd['entry_args'][1]!=ident['primary_context_pointer']:
            raise EvidenceError('Primary command points at a different context')
        association,reason=associate_hand(cmd,handcmd)
        candidate={'main_command_id':cmd['id'],'hand_command_id':handcmd['id'],
                   'flags_u32':cmd['flags_u32'],'execution_bit1_set':True,
                   'primary_frame':cmd['primary_frame_at_entry'],'command_pointer':cmd['entry_args'][0],
                   'hand_source_association':association,'hand_source_missing_reason':reason,'actor_association_indices':[]}
        candidates.append(candidate)
        debits=[r for r in all_debits if cmd['id'] in ancestry[r['id']] and descriptor(r.get('descriptor_raw'))==cmd['descriptor_raw']]
        for debit in debits:
            delta={key:integer(debit.get(key),-0x80000000,0x7fffffff,key)
                   for key in ('elixir_units_before','elixir_units_after','debit_accumulator_before','debit_accumulator_after')}
            spawns=[r for r in all_spawns if debit['id'] in ancestry[r['id']] and pointer(r['return_x0'],'spawn result')!=0]
            origins=[r for r in all_origins if r.get('context_kind')=='primary' and debit['id'] in ancestry[r['id']]]
            for insert in insertions:
                insertion_debits=[a for a in ancestry[insert['id']] if main[a]['event']=='native_card_debit_and_deploy']
                if insertion_debits and debit['id'] not in insertion_debits:continue
                matching=[r for r in origins if r['id']<=insert['id'] and r['entry_args'][:2]==insert['entry_args'][:2]]
                if not matching:continue
                origin=matching[-1]
                # Native character creation returns the actor before the sibling
                # registration call. Do not require the latter to be nested in it.
                created=[r for r in spawns if r['id']<origin['id'] and r['return_x0']==origin['entry_args'][1]
                         and r['id'] not in ancestry[origin['id']]]
                if len(created)!=1:continue
                spawn=created[0]
                intervening=[r for r in all_origins if origin['id']<r['id']<insert['id']
                             and r['entry_args'][:2]==insert['entry_args'][:2] and debit['id'] not in ancestry[r['id']]]
                if intervening:continue
                linked_hand=association if association is not None and debit['entry_args'][0]==association['king_pointer'] else None
                chain={'main_command_id':cmd['id'],'hand_command_id':handcmd['id'],'flags_u32':cmd['flags_u32'],
                       'native_debit_event_id':debit['id'],'native_character_spawn_event_id':spawn['id'],
                       'spawn_returned_actor_pointer':spawn['return_x0'],'actor_origin_event_id':origin['id'],
                       'native_live_insertion_event_id':insert['id'],'world_pointer':insert['entry_args'][0],
                       'actor_pointer':insert['entry_args'][1],'native_actor_id_u32':insert['membership_after']['native_actor_id_u32'],
                       'debit_observations':delta,'hand_source_association':linked_hand,
                       'command_to_debit_parent_link_observed':True,'debit_to_spawn_parent_link_observed':True,
                       'spawn_return_to_registration_pointer_match':True,
                       'command_to_insertion_entire_parent_chain_observed':debit['id'] in ancestry[insert['id']],
                       'insertion_association':'nested original call chain' if debit['id'] in ancestry[insert['id']]
                                                else 'later matching original spawn-result actor/world pointer; temporal association only'}
                if not any(c['native_live_insertion_event_id']==insert['id'] for c in chains):
                    chains.append(chain);candidate['actor_association_indices'].append(len(chains)-1)
    return {'schema':'native-placement-selected-lineage-v2','identity':ident,
            'native_execution_candidates':candidates,'selected_execution_actor_associations':chains,
            'selected_execution_actor_association_observed':bool(chains),
            'parent_linked_command_debit_spawn_observed':bool(chains),
            'fully_parent_linked_command_to_insertion_observed':any(c['command_to_insertion_entire_parent_chain_observed'] for c in chains),
            'native_hand_source_association_observed':any(c['hand_source_association'] is not None for c in chains),
            'native_clone_transition_observed':False,
            'complete_hand_ownership_proven':False,'complete_causality_proven':False,
            'complete_match_proven':False,'ordinary_match_equivalence_proven':False,'android_parity_proven':False,
            'static_execution_predicate':{'argument':'w2','preserved_at':'0xd77530','bit':1,
                                         'native_branch_sites':['0xd7774c','0xd7787c'],
                                         'scope':'Original command branch uses bit1; no requirement that bit0 also be set.'},
            'limits':['Entry order and returned flags are available; return timestamps and full object lifetimes are not.',
                      'Actual creation-return actor pointers link sibling registration within the same debit ancestry.',
                      'Different queued/executed commands have matching selected fields and live getter; the native clone transition is unobserved.',
                      'Delayed insertion is a selected pointer/parent association, not complete causal serialization.',
                      'Reports still require independent pinned-source/input/uninterrupted-execution provenance.']}


def load_receipt(path):
    if path.stat().st_size > 128 * 1024 * 1024:
        raise EvidenceError('Receipt exceeds offline input bound')
    result=json.loads(path.read_text())
    if type(result) is dict and set(result) == {'scope','observer'}:
        if type(result['scope']) is not str:
            raise EvidenceError('Invalid controller receipt scope')
        return result['observer'], result['scope']
    return result, None


def main():
    p=argparse.ArgumentParser();p.add_argument('--main',type=Path,required=True);p.add_argument('--hand',type=Path,required=True)
    args=p.parse_args()
    try:
        m,ms=load_receipt(args.main); h,hs=load_receipt(args.hand)
        result=analyze(m,h)
        result['input_scope_labels']={'main':ms,'hand':hs}
    except (EvidenceError, KeyError, TypeError) as exc:
        print(json.dumps({'schema':'native-placement-selected-lineage-v2','evidence_rejected':str(exc),'selected_execution_actor_association_observed':False},indent=2));return 2
    print(json.dumps(result,indent=2));return 0


if __name__=='__main__':
    raise SystemExit(main())
