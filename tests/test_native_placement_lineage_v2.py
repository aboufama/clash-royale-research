"""Synthetic receipts only: controls do not assert an actual native placement."""
from copy import deepcopy
import json
import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from native_placement_lineage_v2 import analyze, EvidenceError

IDENT={'runner_pointer':'0x1000','primary_context_pointer':'0x2000','primary_level_pointer':'0x3000'}
D='11'*20
VAS={'command153_execute':0xd77504,'command_queue_insert':0xd75a44,'native_card_debit_and_deploy':0xf9ea68,
     'native_character_spawn':0xd35ab4,'native_actor_registration_request':0xf8c294,'native_actor_enqueue':0xf8c2bc,
     'native_actor_register':0xf8c50c,'native_level_end_commit':0xd3e360,'native_hand_slot_get':0xf9dd98,
     'native_live_hand_descriptor_build':0xe80bbc,'native_command153_descriptor_set':0xd77c8c}


def event(index,label,args=(),parent=None,**kw):
    row=dict(id=index,event=label,entry_elf_va=hex(VAS[label]),entry_lr='0x10001000',entry_sp='0x80000000',
             entry_args=[hex(v) for v in list(args)+[0]*(8-len(args))],identity_at_entry=deepcopy(IDENT),
             primary_frame_at_entry=10,returned=True,observed_parent_id=parent,return_x0='0x0')
    row.update(kw);return row


def report(schema,rows):
    counts={}
    for row in rows:counts[row['event']]=counts.get(row['event'],0)+1
    return dict(schema=schema,identity=deepcopy(IDENT),identity_at_report=deepcopy(IDENT),
                events=rows,counts=counts,pending_event_ids=[],error=None)


def fixtures(delayed=False):
    cmd=event(0,'command153_execute',[0x4000,0x2000,3],context_kind='primary',flags_u32=3,
              authoritative_frame=10,client_frame=9,coordinates=[100,200],descriptor_raw=D,native_return_signed32=0)
    debit=event(1,'native_card_debit_and_deploy',[0x5000,0x6000],0,descriptor_raw=D,
                elixir_units_before=50,elixir_units_after=30,debit_accumulator_before=0,debit_accumulator_after=20)
    spawn=event(2,'native_character_spawn',[0x3000],1,return_x0='0x8000')
    origin=event(3,'native_actor_enqueue',[0x7000,0x8000],1,context_kind='primary')
    membership=dict(world_pointer='0x7000',actor_pointer='0x8000',vector_pointer='0x9000',count_signed32=2,
                    actor_occurrences=0,native_actor_id_u32=0)
    reg=event(4,'native_actor_register',[0x7000,0x8000,0,1],None if delayed else 1,context_kind='primary',
              membership_before=membership,membership_after=dict(membership,count_signed32=3,actor_occurrences=1,native_actor_id_u32=8),
              insert_argument_u32=1,new_live_membership_observed=True)
    getter=event(0,'native_hand_slot_get',[0x5000,2],king_pointer='0x5000',hand_slot_signed32=2,
                 returned_hand_card_pointer='0xa000',return_x0='0xa000')
    builder=event(1,'native_live_hand_descriptor_build',[0xa000,0x5000,0],hand_card_pointer='0xa000',king_pointer='0x5000',
                  builder_option_u32=0,native_output_pointer='0xb000',native_output_descriptor_raw=D)
    setter=event(2,'native_command153_descriptor_set',[0x4000,0xb000],command_pointer='0x4000',
                 source_descriptor_pointer='0xb000',source_descriptor_raw=D,command_descriptor_raw_after=D,
                 observed_descriptor_copy_matches=True)
    handcmd=deepcopy(cmd);handcmd['id']=3
    meta=dict(command_pointer='0x4000',sequence_signed32=7,account_words_u32=[2,3],descriptor_raw=D)
    handcmd.update(command_metadata_before=deepcopy(meta),command_metadata_after=deepcopy(meta))
    return report('native-match-observer-v2',[cmd,debit,spawn,origin,reg]),report('native-hand-provenance-v1',[getter,builder,setter,handcmd])


def queued_fixtures():
    m,h=fixtures(True)
    validation=deepcopy(m['events'][0]);validation['flags_u32']=1;validation['entry_args'][2]='0x1'
    validation['authoritative_frame']=-1
    queue=event(1,'command_queue_insert',[0x9900,0xbb00],command_pointer='0x4000',context_kind='primary',queue_count_before=0,queue_count_after=1)
    committed=deepcopy(m['events'][0]);committed['id']=2;committed['entry_args'][0]='0x4100';committed['flags_u32']=2;committed['entry_args'][2]='0x2';committed['authoritative_frame']=-1
    tail=deepcopy(m['events'][1:])
    for row in tail:
        row['id']+=2
        if row['observed_parent_id'] is not None:row['observed_parent_id']+=2
    m=report(m['schema'],[validation,queue,committed]+tail)
    v=deepcopy(h['events'][3]);v.update({k:deepcopy(value)for k,value in validation.items()});v['id']=3
    v['command_metadata_before']['sequence_signed32']=-1
    v['command_metadata_after']['sequence_signed32']=7
    c=deepcopy(h['events'][3]);c.update({k:deepcopy(value)for k,value in committed.items()});c['id']=4
    for key in ('command_metadata_before','command_metadata_after'):c[key]['command_pointer']='0x4100'
    g=deepcopy(h['events'][0]);g['id']=5;g['observed_parent_id']=4
    h=report(h['schema'],h['events'][:3]+[v,c,g])
    return m,h


class Controls(unittest.TestCase):
    def rejected(self,edit):
        m,h=queued_fixtures();edit(m,h)
        with self.assertRaises(EvidenceError):analyze(m,h)
    def no_chain(self,edit):
        m,h=queued_fixtures();edit(m,h);self.assertFalse(analyze(m,h)['selected_execution_actor_association_observed'])
    def no_hand(self,edit):
        m,h=queued_fixtures();edit(m,h);r=analyze(m,h)
        self.assertTrue(r['selected_execution_actor_association_observed']);self.assertFalse(r['native_hand_source_association_observed'])
    def test_native_bit2_queued_source(self):
        r=analyze(*queued_fixtures());self.assertTrue(r['selected_execution_actor_association_observed']);self.assertTrue(r['native_hand_source_association_observed'])
        self.assertFalse(r['fully_parent_linked_command_to_insertion_observed']);self.assertTrue(r['parent_linked_command_debit_spawn_observed'])
        self.assertFalse(r['native_clone_transition_observed']);self.assertFalse(r['complete_causality_proven']);self.assertFalse(r['android_parity_proven'])
    def test_bit3_same_pointer(self):
        r=analyze(*fixtures());self.assertTrue(r['native_hand_source_association_observed'])
    def test_negative_one_authoritative_frame_admitted(self):
        m,h=queued_fixtures();self.assertEqual(m['events'][0]['authoritative_frame'],-1);self.assertTrue(analyze(m,h)['selected_execution_actor_association_observed'])
    def test_flags1_alone_no_execution(self):
        def edit(m,h):
            for row in(m['events'][2],h['events'][4]):row['flags_u32']=1;row['entry_args'][2]='0x1'
        self.no_chain(edit)
    def test_flags4_without_bit1_no_execution(self):
        def edit(m,h):
            for row in(m['events'][2],h['events'][4]):row['flags_u32']=4;row['entry_args'][2]='0x4'
        self.no_chain(edit)
    def test_failed_execution_no_chain(self):
        def edit(m,h):
            for row in(m['events'][2],h['events'][4]):row['native_return_signed32']=13;row['return_x0']='0xd'
        self.no_chain(edit)
    def test_secondary_no_primary_chain(self):
        def edit(m,h):
            for row in(m['events'][2],h['events'][4]):row['context_kind']='secondary'
        self.no_chain(edit)
    def test_zero_elixir_delta_permitted(self):
        m,h=queued_fixtures();m['events'][3]['elixir_units_after']=50;self.assertTrue(analyze(m,h)['selected_execution_actor_association_observed'])
    def test_missing_return_rejected(self):self.rejected(lambda m,h:m['events'][3].update(returned=False))
    def test_pending_rejected(self):self.rejected(lambda m,h:h.update(pending_event_ids=[1]))
    def test_bool_result_rejected(self):self.rejected(lambda m,h:m['events'][2].update(native_return_signed32=False))
    def test_bool_flags_rejected(self):self.rejected(lambda m,h:m['events'][2].update(flags_u32=True))
    def test_bool_frame_rejected(self):self.rejected(lambda m,h:m['events'][2].update(authoritative_frame=False))
    def test_bool_sequence_rejected(self):self.rejected(lambda m,h:h['events'][4]['command_metadata_before'].update(sequence_signed32=True))
    def test_bool_account_rejected(self):self.rejected(lambda m,h:h['events'][4]['command_metadata_before'].update(account_words_u32=[True,3]))
    def test_wrong_primary_identity_rejected(self):self.rejected(lambda m,h:h['identity_at_report'].update(primary_context_pointer='0x2001'))
    def test_command_occurrence_disagreement_rejected(self):self.rejected(lambda m,h:h['events'][4].update(entry_lr='0x10001004'))
    def test_wrong_native_va_rejected(self):self.rejected(lambda m,h:m['events'][3].update(entry_elf_va='0xf9ea6c'))
    def test_counts_alone_rejected(self):self.rejected(lambda m,h:m.update(events=[]))
    def test_self_parent_rejected(self):self.rejected(lambda m,h:m['events'][3].update(observed_parent_id=3))
    def test_spawn_return_wrong_actor(self):self.no_chain(lambda m,h:m['events'][4].update(return_x0='0x8001'))
    def test_spawn_return_null_actor(self):self.no_chain(lambda m,h:m['events'][4].update(return_x0='0x0'))
    def test_spawn_unrelated_debit(self):self.no_chain(lambda m,h:m['events'][4].update(observed_parent_id=None))
    def test_registration_unrelated_debit(self):self.no_chain(lambda m,h:m['events'][5].update(observed_parent_id=None))
    def test_debit_not_under_command(self):self.no_chain(lambda m,h:m['events'][3].update(observed_parent_id=None))
    def test_original_spawn_still_pending(self):self.no_chain(lambda m,h:m['events'][5].update(observed_parent_id=4))
    def test_no_actual_insert(self):
        def edit(m,h):
            row=m['events'][6];row.update(insert_argument_u32=0,new_live_membership_observed=False,membership_after=deepcopy(row['membership_before']));row['entry_args'][3]='0x0'
        self.no_chain(edit)
    def test_forged_insertion_label_rejected(self):self.rejected(lambda m,h:m['events'][6]['membership_after'].update(actor_occurrences=0))
    def test_wrong_insert_word_rejected(self):self.rejected(lambda m,h:m['events'][6].update(insert_argument_u32=2))
    def test_wrong_membership_actor_rejected(self):self.rejected(lambda m,h:m['events'][6]['membership_after'].update(actor_pointer='0x8001'))
    def test_wrong_source_descriptor_only_loses_hand_association(self):self.no_hand(lambda m,h:h['events'][1].update(native_output_descriptor_raw='22'*20))
    def test_wrong_returned_hand_only_loses_hand_association(self):self.no_hand(lambda m,h:h['events'][0].update(return_x0='0xa001',returned_hand_card_pointer='0xa001'))
    def test_unobserved_queue_only_loses_hand_association(self):self.no_hand(lambda m,h:m['events'][1].update(context_kind='secondary'))
    def test_queue_not_grown_only_loses_hand_association(self):self.no_hand(lambda m,h:m['events'][1].update(queue_count_after=0))
    def test_mismatched_sequence_only_loses_hand_association(self):self.no_hand(lambda m,h:h['events'][3]['command_metadata_after'].update(sequence_signed32=8))
    def test_current_hand_getter_mismatch_only_loses_hand_association(self):self.no_hand(lambda m,h:h['events'][5].update(return_x0='0xa001',returned_hand_card_pointer='0xa001'))
    def test_execution_hand_getter_outside_command_only_loses_hand_association(self):self.no_hand(lambda m,h:h['events'][5].update(observed_parent_id=None))
    def test_wrong_debit_king_only_loses_hand_association(self):self.no_hand(lambda m,h:m['events'][3]['entry_args'].__setitem__(0,'0x5001'))
    def test_reports_unchanged(self):
        m,h=queued_fixtures();original=deepcopy((m,h));analyze(m,h);self.assertEqual((m,h),original)


if __name__=='__main__':unittest.main()
