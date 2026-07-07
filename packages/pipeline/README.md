# Pipeline

Offline data pipeline. Each stage is a standalone script that reads and writes artifacts under `data/` (gitignored) so any stage can be re-run in isolation.

Planned stage order:

1. `discover` - films, genres, and keywords from TMDb
2. `extract` - cached transcript HTML to ordered subtitle cues
3. `utterances` - cues merged and split into clean spoken lines
4. `rescue` - secondary sources for films with no transcript
5. `segment` - exchanges (overlapping windows) and scene-scale chunks
6. `embed` - sentence embeddings at each context size
7. `aggregate` - movie vectors and movie pair similarity
8. `cliches`, `twins`, `five-lines`, `labels` - derived surfaces
9. `load` - ClickHouse native-format load with atomic table swap

Stages land alongside the features that consume them.
