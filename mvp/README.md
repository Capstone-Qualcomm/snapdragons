# Continuum MVP

Interactive concept page for the Qualcomm CS 620 project: a persistent agent runtime that scales out across Arduino Uno Q nodes and continues through worker or conductor failure.

Run locally:

```bash
cd mvp
python3 -m http.server 8080
```

Open `http://localhost:8080`. The live cluster graphic continuously demonstrates a cross-node Slack dependency, a worker failure, eight-task redistribution, and recovery while all 40 tasks remain accounted for.
