# 0002/0005 — B4.1: Ponte Main/Preload e contratos IPC

## Identificação

- Ticket: 0002/0005
- Ticket pai: 0002 — Fase B: Base funcional Standalone
- Etapa canônica: B4.1
- Status: Concluído
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Implementar e testar a ponte tipada Standalone em harness isolado, com validação de remetente e snapshots versionados.

## Escopo

- Expor somente getSnapshot, execute, subscribe e unsubscribe.
- Validar canal, payload, WebContents, frame principal e URL.
- Preservar ordenação de revisões, geração de subscription, cópias de DTO e cleanup.

## Decisões aprovadas

- Preload dedicado restrito; nenhuma API genérica, caminho local ou acesso Node exposto.
- Handlers não foram registrados no main.ts de produção.

## Pendências

- Ativação na janela de produção e IPC real em fluxo de produto ficaram para etapas posteriores.

## Riscos

- Uma operação admitida continua no runtime após descarte da bridge; a resposta IPC não pode devolver snapshot obsoleto.

## Histórico de execução

B4.1 foi implementada e testada em Electron Linux no harness.

## Validação

Compile PASS; teste IPC 15/15; regressões focadas PASS; E2E Electron/Preload/IPC real PASS. Não é validação de playback real nem Windows nativo.

## Referências

- [standalone-player-roadmap.md](../../standalone-player-roadmap.md)
- [remote-player-architecture.md](../../remote-player-architecture.md)
- [player-playback.md](../../player-playback.md)
