# 0006/0002 — F2: Validação do aplicativo instalado

## Identificação

- Ticket: 0006/0002
- Ticket pai: 0006 — Fase F: Regressão e estabilização pós-instalação
- Etapa canônica: F2
- Status: Planejado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Verificar o executável empacotado e os atalhos no Windows em ambiente de instalação real.

## Escopo

- Testar inicialização pelos atalhos, nomes/ícones/função, UI, áudio/vídeo, filesystem e limpeza de processos/recursos.
- Usar computadores diferentes quando disponíveis.

## Decisões aprovadas

- Sucesso em ambiente de desenvolvimento não comprova o pacote instalado.

## Pendências

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
