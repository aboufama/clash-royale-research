# Replays

Matches recorded by the RL environment (`sim/rl`, `train/crl/evaluate.py --replays DIR`): the battle
seed, the decks and every accepted play by tick. The engine is deterministic, so the viewer replays a
match exactly from these few kilobytes: open `index.html?replay=replays/<file>.json`.

Blue (team 0) is the first deck, red the second; `ctrl` says who played each side (`py` = the trained
agent, `bot` = the scripted AI).
