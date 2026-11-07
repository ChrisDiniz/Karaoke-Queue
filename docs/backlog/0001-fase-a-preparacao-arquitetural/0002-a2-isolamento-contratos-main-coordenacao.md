# 0001/0002 — A2: Isolamento, contratos e coordenação Main-side

## Identificação

- Ticket: 0001/0002
- Ticket pai: 0001 — Fase A: Preparação arquitetural
- Etapa canônica: A2
- Status: Concluído
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Preparar os contratos e a composição isolada da sequência Standalone sem ativar o aplicativo, a UI, IPC de produção ou modos.

## Escopo

- Definir contratos de estado, comandos, resultados, eventos, IDs de operação e correlação de tentativas.
- Criar composição Main-side injetável e árbitro de transições, mantendo efeitos assíncronos fora da lane síncrona.
- Documentar limites de recovery, retry, retenção do ledger e sequência volátil.

## Subetapas

### A2.1 — Contratos e base isolada

**Status:** Concluído

**Descrição:** Define snapshots discriminados, porta estreita de playback, operações e correlação. A sequência é volátil; blocked/uncertain não autorizam autoplay ou retry cego. Validação registrada: Contratos 3/3; sem validação de engine, UI ou mídia.

### A2.2 — Composição Main-side e coordenação

**Status:** Concluído

**Descrição:** Implementa runtime injetável, árbitro síncrono, lane curta para iniciar efeitos e commit confirmado. Deduplica operationId durante a vida da instância Main. Validação registrada: Runtime 18/18 e recovery compartilhado 30/30; fakes, sem integração de produção.


## Decisões aprovadas

- A2.1 — Contratos e base isolada.
- A2.2 — Composição Main-side e coordenação.

## Pendências

- A integração com main.ts, Preload, IPC, Renderer, host Electron e fluxo de produção ficou para etapas posteriores.
- A fila Standalone não adquiriu persistência em SQLite.

## Riscos

- Ledger operationId volátil e retido até descarte; não garante deduplicação após reinício.
- Callbacks e adaptadores futuros precisam reconciliar resultados incertos e validar reserva/tentativa antes de publicar.

## Histórico de execução

A2.1 e A2.2 foram concluídas como infraestrutura isolada; limites e revisões técnicas estão registrados no roadmap.

## Validação

Compile passou. A2.1: contratos 3/3. A2.2: runtime 18/18 e recovery compartilhado 30/30. Os testes são focados e não validam UI nem playback real.

## Referências

- [standalone-player-roadmap.md](../../standalone-player-roadmap.md)
- [player-playback.md](../../player-playback.md)
- [sqlite-persistence-safety.md](../../sqlite-persistence-safety.md)
