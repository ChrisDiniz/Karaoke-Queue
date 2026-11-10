# 0004/0002 — D2: Auditoria e limpeza controlada do legado

## Identificação

- Ticket: 0004/0002
- Ticket pai: 0004 — Fase D: Auditoria, limpeza e modularização do Main
- Etapa canônica: D2
- Status: Concluído
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Remover gradualmente somente a implementação visual antiga do Player que foi substituída pelo Standalone atual. A organização física de `src/` permanece como aprovada em D1.2/D1.3. A D1.4 foi aceita pelo proprietário como baseline em 2026-11-07 com as limitações históricas registradas no ticket D1; essas limitações não bloqueiam esta limpeza.

## Escopo

- Identificar consumidores reais antes de qualquer remoção.
- Classificar UI, regras, serviços e testes segundo suas responsabilidades e usos.
- Reunir evidências de obsolescência e ausência de consumidores necessários antes de remover cada grupo.
- Preservar os dados, regras, serviços e componentes operacionais do Controller necessários à Gestão no Combined, especialmente à futura H1.
- Preservar também playback, biblioteca, catálogo, recovery e contratos compartilhados necessários à Standalone, à Gestão/Combined e às fases G/H.
- Não tratar “legado” como sinônimo de descartável; não remover funcionalidade apenas por pertencer ao Controller independente.
- Remover em grupos pequenos e corrigir regressões entre grupos.
- Remover o shell sem consumidor de runtime (`src/player-control-renderer.ts`, HTML/CSS, `player-control-preload.ts` e `createPlayerControlWindow()`), os artefatos exclusivos de cópia/bundle e as suítes/flags exclusivas desse shell; atualizar o agregador, runner Windows e documentação para que não apontem a arquivos removidos.
- Preservar `ManualPlaybackService`, `PlayerPlaybackService`, `PlayerVideoWindow`, host Chromium, protocolo de mídia, biblioteca, catálogo, recovery e contratos/handlers IPC compartilhados. A bridge `player:*` em `preload.ts` e os handlers Controller/Combined ficam preservados como compatibilidade/transição; D2 não remove autoridades ou serviços de playback.
- A única suíte retirada da matriz ativa é `player-control-electron`, que espera o shell desativado. Cobertura atual de produção permanece em Standalone production, modos, recovery e demais suítes aplicáveis.
- A limpeza não implementa nem prepara stubs de rede; responsabilidades de transporte remoto serão avaliadas separadamente em D4 e implementadas somente na Fase G.

## Dependências

- D1.1–D1.3 concluídas segundo a decisão aprovada; D1.2 alternativa A aprovada e D1.3 sem movimentações.
- A estrutura resultante estabilizada.
- D1.4 baseline aceita pelo proprietário, incluindo as limitações históricas explicitamente aceitas; nenhuma revalidação é condição para D2.
- D2 deve estar concluída antes da regressão D3; D3 aprovada será o gate de entrada para a auditoria D4.
- Autorização explícita do proprietário para execução sequencial D2 e D3 recebida em 2026-11-07.

## Critérios de conclusão

- Cada remoção tem evidência de obsolescência e inventário de consumidores.
- O domínio de Gestão continua preservado: mesas, cantores, sessões, histórico, fila inteligente, Round Robin, prioridades/posições protegidas, SQLite, conclusão/cancelamento e recovery.
- Serviços compartilhados necessários a H1 e à comunicação remota futura permanecem disponíveis.
- Alterações e regressões verificadas ficam registradas para a validação D3.
- Nenhuma remoção é justificada apenas pela ausência de uso no Controller transitório se o módulo for necessário ao Combined, Standalone ou às fases G/H.

## Histórico

Responsabilidade derivada da antiga subetapa E1.4. A limpeza D2 está autorizada pelo proprietário. A implementação não altera a estrutura física de `src/` nem antecipa D4, D5 ou a Fase E.

### Inventário e evidências de D2

- **Removíveis e exclusivamente legados:** `src/player-control-renderer.ts`, `src/player-control.html`, `src/player-control.css`, `player-control-preload.ts`, a função sem call site `createPlayerControlWindow()` em `main.ts`, o bundle/cópia desses artefatos em `scripts/copy-assets.ts`, `scripts/player-control-renderer-bundle.test.cjs`, `tests/player-control-electron.ts`, os scripts `test:e2e:player-control:*`, o modo Windows `--player-control` e as respectivas expectativas de bundle no teste do runner.
- **Compartilhados e preservados:** `ManualPlaybackService`, `PlayerPlaybackService`, `PlayerVideoWindow`, host Chromium/renderer técnico, protocolo de mídia, biblioteca, catálogo, recovery/store, `src/player-ui-contracts.ts`, handlers `player:*` e a superfície geral `preload.ts`. Evidências de consumidores/autoridade: composição em `main.ts`; adapter Standalone e harnesses de playback/recovery; verificações de origem IPC; compatibilidade operacional Controller/Combined. `player-playback.html/css` não são o shell de controle: são a superfície técnica Chromium e permanecem.
- **Compatibilidade transitória preservada:** API tipada `karaokePlayer` dentro do preload geral e handlers Controller/Combined ainda registrados, embora a busca não tenha encontrado consumidor Renderer atual fora do shell removido. Removê-los exigiria análise separada da compatibilidade Controller/Combined e não é necessário para retirar a implementação visual obsoleta.
- **Artefatos ignorados:** antes da limpeza, o build local continha `build/player-control-preload.js`, cópias HTML/CSS, bundle e JS do renderer e o JS da suíte E2E. Foram removidos somente esses outputs gerados obsoletos após verificar que `build/` é ignorado e que não são fontes rastreadas. A compilação atual não os recria.
- **Referências restantes verificadas:** os nomes antigos que permanecem em `scripts/windows-native-runner.test.cjs` afirmam que o launcher rejeita a flag removida e que o manifesto não espera aqueles outputs; `tests/operating-modes-electron.ts` verifica que a janela antiga não inicia. O elemento `player-control-hint` em `player-playback.html` pertence ao host Chromium técnico compartilhado e não ao shell deletado; sua ponte/markup foram preservados com esse host. Não há script ativo que lance a tela antiga.
- **Validação D2:** `npm run compile` — PASS; `npm run test:unit` — PASS (incluindo o teste atualizado do runner Windows); `npm run test:unit:standalone-contracts` — PASS. Varredura do build encontrou e confirmou a ausência de artefatos `player-control` gerados depois da limpeza.
- **Resultado:** o shell visual antigo, seu preload exclusivo e as suítes/scripts que dependiam exclusivamente dele foram removidos; os serviços e contratos necessários à Standalone e Gestão/Combined permanecem. A revisão integrada do estado final e a campanha completa D3 prosseguem no ticket D3.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Ticket D1 — Auditoria e reorganização do `src`](0001-d1-auditoria-reorganizacao-src.md)
- [Remote player architecture](../../remote-player-architecture.md)
- [Legacy session compatibility](../../legacy-session-compatibility.md)
- [Round Robin incremental](../../round-robin-incremental.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
- [Preparação arquitetural Main/rede para D4 e G](../../d4-main-remote-architecture-preparation.md)
