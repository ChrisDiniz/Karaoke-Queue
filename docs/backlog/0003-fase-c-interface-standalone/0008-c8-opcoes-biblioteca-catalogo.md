# 0003/0008 — C8: Opções de acervo e catálogo CSV

## Identificação

- Ticket: 0003/0008
- Ticket pai: 0003 — Fase C: Interface Standalone
- Etapa canônica: C8
- Status: Concluído
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Configurar/atualizar biblioteca somente em idle e importar/substituir CSV sem alterar reprodução ou fila.

## Escopo

- Reutilizar VideoLibraryService e MusicCatalogService.
- Validar o estado ocupado no Main, preservar biblioteca configurada degradada e impedir scans inconsistentes.
- Exibir indexação real sem percentual/ETA; manter catálogo opcional e transacional.
- Integrar opções ao menu C7; manter Sair desabilitado até C9.

## Implementação da importação parcial

- Somente `INVALID_MUSIC_NUMBER` é recuperável para a importação Standalone quando a estrutura do CSV continua inequívoca e há pelo menos um registro válido. O parser estrito continua rejeitando esse erro para consumidores que dependem da validação integral; duplicatas, erros estruturais, arquivo ilegível, limites excedidos e catálogo sem registros válidos continuam bloqueando a importação.
- A prévia parcial prepara os registros válidos sem gravar. A confirmação é obrigatória; cancelar ou falhar preserva catálogo, contagem, última importação, relatório anterior, metadados e playback.
- A confirmação substitui registros e relatório na mesma transação do banco Player-only. Schema v3 persiste relatório paginado e geração para invalidar confirmações antigas. Uma importação válida sem erros limpa o relatório anterior.
- Opções acrescenta apenas a linha discreta “Ver problemas” e um modal consultivo paginado, com linha, campo, valor e motivo. A composição existente foi preservada; nenhum frame Doop foi alterado.

## Decisões aprovadas

- Alteração de pasta só quando Player estiver completamente ocioso.
- CSV pode ser importado durante reprodução e não determina disponibilidade de vídeo.
- Painel de seleção de modo permanece inerte nesta etapa conforme frame atual.

## Validação manual e aprovação

- O proprietário confirmou nesta interação que o problema de importação foi resolvido e que concluiu satisfatoriamente a validação manual da C8 no Windows. **C8 — CONCLUÍDA / APROVADA MANUALMENTE NO WINDOWS.**
- A limitação do Playwright ao selecionar fisicamente um arquivo no diálogo nativo permanece registrada como limite da automação; não invalida a aprovação manual informada e não significa que o diálogo tenha sido automatizado.
- C9 continua planejada; sua implementação exige autorização específica.

## Riscos

- Scan não oferece cancelamento individual nem progresso granular; otimizações de grande acervo pertencem a C11.
- Diferença entre caminhos ilustrativos e basename exibido está documentada como decisão de segurança.

## Histórico de execução

Implementação e correção do bundle Renderer foram concluídas antes da validação manual final; o estado pendente daquele momento foi posteriormente encerrado pela aprovação do proprietário registrada abaixo.

Adendo C8 — importação parcial: o E2E Windows revelou que o validador de resposta do Preload não aceitava `importGeneration`; o contrato foi corrigido e o E2E final passou. A confirmação agora informa a contagem válida/ignorável e o modal registra os dados da linha rejeitada sem truncamento ou correção automática.

Aprovação final: após a correção da importação parcial, o proprietário confirmou nesta interação que a validação manual da C8 no Windows terminou satisfatoriamente. O status atual substitui os registros anteriores de validação pendente; os resultados automatizados e seus limites foram preservados.

## Validação

`npm run test:unit:standalone-ui` — PASS (compile e 114 testes: 43 interação, 12 preview, 29 IPC, 5 Options, 25 catálogo). `npm run test:e2e:standalone-options:windows -- --approve-untracked` pelo runner oficial — PASS em Electron nativo, Playwright, IPC, SQLite isolado e MP4; usou os dois CSVs reais do Windows, confirmou 15.115 registros válidos e o problema da linha 135, persistência após reiniciar e reprodução/fila inalteradas. A primeira execução E2E encontrou a incompatibilidade do DTO do Preload; após a correção, o runner foi repetido com sucesso. `npm run test:e2e:standalone-options:headless` — NOT RUN porque Chromium no ambiente Linux encerrou no sandbox do host (`Operation not permitted`); não foi desativada proteção. O teste Windows usa porta de diálogo exclusiva do harness; a aprovação manual do proprietário está registrada separadamente e não atribui ao Playwright a interação física com o seletor nativo.

Comparação visual real Electron × Doop em 1280×800/DPR 1: o painel C8 mantém a geometria aprovada; a linha de aviso cabe sem overflow nem alteração do tamanho/alinhamento do grid; confirmação e relatório aparecem em modais centralizados. Capturas: `C:\Users\Chris\AppData\Local\Temp\kq-standalone-c1-captures-Y267HA\c8-partial-import-confirmation.png`, `...\c8-real-csv-partial-import-confirmed.png` e `...\c8-real-csv-partial-import-problems.png`. Doop permaneceu inalterado. Automação e comparação visual não equivalem à aprovação manual do proprietário.

## Referências

- [standalone-player-roadmap.md](../../standalone-player-roadmap.md)
- [standalone-player-ui-plan.md](../../standalone-player-ui-plan.md)
- [video-library.md](../../video-library.md)
- [music-catalog.md](../../music-catalog.md)
- [sqlite-persistence-safety.md](../../sqlite-persistence-safety.md)
