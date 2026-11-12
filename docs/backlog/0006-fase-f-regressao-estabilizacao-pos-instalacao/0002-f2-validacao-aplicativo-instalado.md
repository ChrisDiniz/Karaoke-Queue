# 0006/0002 — F2: Validação do aplicativo instalado

**Status vigente — 2026-11-11: Concluído e validado pelo proprietário.** O aceite global da Fase F nesta sessão abrange esta etapa e suas subdivisões. [Encerramento consolidado e limites das evidências](../../fase-f-encerramento.md). O conteúdo abaixo preserva o planejamento e os checkpoints históricos; referências a não início ou homologação pendente estão superadas para acompanhamento, sem converter PARTIAL/NOT RUN/FAIL em PASS.

## Identificação

- Ticket: 0006/0002
- Ticket pai: 0006 — Fase F: Regressão e estabilização pós-instalação
- Etapa canônica: F2
- Status: Concluído e validado pelo proprietário (2026-11-11)
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Verificar o executável empacotado e os atalhos no Windows em ambiente de instalação real.

## Escopo

- Testar inicialização pelos atalhos, nomes/ícones/função, UI, áudio/vídeo, filesystem e limpeza de processos/recursos.
- Usar computadores diferentes quando disponíveis.

## Decisões aprovadas

- Sucesso em ambiente de desenvolvimento não comprova o pacote instalado.

## Pendências registradas antes do encerramento

- Disponibilidade de dispositivos e instalação Windows nativa.

## Riscos

- O smoke test de pacote não substitui validação da instalação NSIS interativa.

## Histórico de execução

Planejado / Não iniciado. Nenhuma execução iniciada.

## Validação

Runner/build e smoke test Windows, execução de UI e mídia real em perfil temporário.

## Referências

- [standalone-player-roadmap.md](../../standalone-player-roadmap.md)
- [windows-release-process.md](../../windows-release-process.md)
- [windows-native-testing.md](../../windows-native-testing.md)

## Dependência F0 — registro histórico de 2026-11-10

A [F0](0000-f0-estabilizacao-critica-standalone.md) deve estar concluída e aprovada antes da execução geral de F1–F4. Esta atualização não inicia nem renumera esta etapa; as dependências sequenciais e autorizações individuais permanecem. E está encerrada por declaração do proprietário, sem converter limitações históricas em PASS.
