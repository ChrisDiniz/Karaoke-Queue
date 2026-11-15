# 0007/0005 — G5: Interface dos estados de conexão

## Estado vigente

G5.1 FUNCTIONAL, G5.2 FUNCTIONAL, G5.3 FUNCTIONAL/ACCESSIBILITY e G5.4 FUNCTIONAL: **PASS**. Implementação COMPLETE; validação funcional PASS. O proprietário autorizou auditoria e um único checkpoint funcional local no commit que contém este registro. Não representa aprovação integral da G5.

## Escopo e critérios atendidos

- Main → IPC/Preload → Renderer/DOM reais; identidade exata, TLS/pinning, indisponibilidade/backoff, blocked e recovery_required durável G4 após restart.
- Outbox/journal G3/G4: accepted pendente, unknown conservador, consulta pelo operationId original, timeout/resposta tardia/restart e ausência de reenvio cego.
- Foco/teclado, contenção de atalhos e Ctrl+R, MP4 real sob overlays e z-order funcional Windows.
- Consentimento, descoberta não verificada, OPAQUE/TLS, cancelamento durável, journal-only/restart, renovação/recovery, falhas de cofre/persistência e revogação.

## Evidências e fontes

- [Plano G5, arquitetura e matriz Doop↔código](../../g5-full-execution-plan.md#g5-doop-matrix).
- [Diário consolidado: runs, fingerprints, manifests, hashes e FAIL/PASS/NOT RUN](../../evidence/g5-implementation/README.md). O último run isolado cobre marker G4, não todos os gates anteriores.
- [Roadmap](../../standalone-player-roadmap.md), [contrato pareado](../../paired-mode-contract.md), [sequência/testes](../../paired-mode-execution-plan.md), [interfaces](../../paired-mode-ui-plan.md).

## Pendências e próximos marcos

Refinamento visual Doop↔Electron, aprovação visual do proprietário e auditoria independente integral: **PENDING**. Produção: **NO**. G6/H: **NOT STARTED**. Próxima rodada dedicada a refinamento, sem iniciá-la neste checkpoint.

Preservar código temporário no Player/TV expressamente autorizado, consentimento, oito dígitos, expiração, OPAQUE/TLS, CAS/offline fail-closed, Main-only e unknown. D1/D3/D4/D5 resolvidas; D2 parcialmente resolvida conforme contrato. C9/C10.1 são pendências separadas, sem relaxar assertions. Sem push ou autorização automática de fases posteriores.
