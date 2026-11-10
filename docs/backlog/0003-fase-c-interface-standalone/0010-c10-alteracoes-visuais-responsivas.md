# 0003/0010 — C10: Alterações visuais e responsividade

## Identificação

- Ticket: 0003/0010
- Ticket pai: 0003 — Fase C: Interface Standalone
- Etapa canônica: C10
- Status: C10 encerrada. C10.1–C10.4 concluídas tecnicamente; em 2026-11-06, o proprietário aprovou explicitamente a experiência visual/responsiva atual e a C10.5. As limitações físicas de resolução/escala já registradas não impediram essa aprovação.
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Implementar as mudanças visuais aprovadas, auditar a interface, corrigir problemas comprovados e validar o Standalone em resoluções, proporções e escalas diferentes sem perder fidelidade ao Doop.

## Ordem obrigatória

C10.1 alterações visuais aprovadas → C10.2 remoção visual da seleção de modo em Opções → C10.3 auditoria e registro de problemas → C10.4 adaptação responsiva → C10.5 validação visual final.

## Subetapas

### C10.1 — Implementação das alterações visuais conforme Doop

**Status:** Implementada e validada tecnicamente; abrangida pela aprovação final da C10.5 concedida pelo proprietário em 2026-11-06.

**Descrição:** Implementar a caixa informativa de estado ocioso “Desconectado” e os demais estados visuais previstos nos frames aprovados com comentário `C10.1`.

**Execução registrada:**
- No canvas `wq3cerR6M7`, foram encontradas quatro referências `C10.1`, todas `ready_for_dev` e aprovadas por Chris: `oCIrIjb3Zc` (ocioso), `zL7w5eBVuI` (código informado), `h99n2h7yQj` (código inexistente) e `PWvNA1u0Gb` (música aceita). Descrições completas, HTML editável e renderizações atuais foram consultados pelo Doop MCP; nenhum frame foi alterado.
- Descrições locais correspondentes: `Player Only — Standalone — Ocioso.txt`, `Player Only — Standalone — Ocioso — Código informado.txt`, `Player Only — Standalone — Ocioso — Código inexistente.txt` e `Player Only — Standalone — Ocioso — Música aceita.txt`. A nota `needs_review` nas cópias locais é histórica e diverge do status atual aprovado retornado pelo MCP.
- `src/standalone-player.css`: alinhamento e tipografia de rótulos de status/metadados ajustados aos frames; dígitos da entrada em 26 px na referência e 18 px no breakpoint móvel. A caixa “Desconectado” usa cópia estática; não foi adicionada conectividade nem comportamento remoto.
- `tests/standalone-player-production-electron.ts`: assertions e capturas da caixa, rótulos, dimensões e layouts; interações por teclado no estado ocioso, preview `1001`/Always/Bon Jovi e erro `99999`, verificando ausência de playback e de alteração da fila.
- Linux: `npm run compile`, `npm run test:unit:standalone-ui` e `KQ_PLAYER_TEST_MEDIA_DIR='/mnt/c/Users/Chris/Documents/Video musicas e catalogo' npm run test:e2e:standalone-production:headless` — PASS com Electron/IPC/MP4/SQLite real. Capturas: `/tmp/karaoke-queue-standalone-production-screenshots-1883907/`.
- Windows: `npm run test:e2e:standalone-production:windows -- --approve-untracked` — PASS no runner oficial em clone NTFS isolado, snapshot validado (`branch=feature/remote-player-lan-integration`, `HEAD=1404da0d55fb2672cccab065f8af5df0cfa05e5d`, fingerprint `b3efde809f223c1fadb0867550c30888dc414e5df400a56a4567e337a109d385`). Electron/Playwright Windows nativos, MP4, SQLite/recovery isolados, fallback nativo, limpeza de perfil e ausência de processos residuais passaram. Capturas: `C:\Users\Chris\AppData\Local\Temp\karaoke-queue-standalone-production-screenshots-26000\`.
- Comparação renderizada Electron × Doop em 1280×800: ocioso, preview e código inexistente correspondem em composição, geometria, texto, status, tipografia, cores e alinhamentos. O estado aceito do frame `PWvNA1u0Gb` mostra status “INICIANDO” no rodapé; o countdown Main-side imediato de C3 oculta o painel ocioso. Não se adicionou atraso nem se alterou C3. A aprovação final do proprietário em 2026-11-06 abrange a experiência C10 atual.

**Critérios:** os estados correspondem às referências aprovadas; “Desconectado” é somente uma apresentação visual inicial; nenhum estado de rede ou telemetria é simulado.

### C10.2 — Remoção visual da seleção de modo em Opções

**Status:** Implementada e validada tecnicamente; abrangida pela aprovação final da C10.5 concedida pelo proprietário em 2026-11-06.

**Descrição:** Remover visualmente o painel “Modo de operação” e a ação “Alterar modo”, reorganizando a tela existente e preservando biblioteca, pasta de vídeos, indexação/refresh, importação CSV, informações do catálogo, relatório de registros problemáticos, toasts e modais.

**Execução registrada:**
- A captura anterior C8 (`/tmp/kq-standalone-c1-captures-jf1GrR/c8-options-indexed-and-catalog-absent.png`) mostra o painel/ação do modo. O frame C8 `s18tg4xb7B` permanece aprovado e inalterado; a adaptação foi autorizada pelo proprietário sem frame próprio C10.2.
- No início desta alteração, o HTML já não continha `#options-mode-panel` nem `#apply-mode`; confirmou-se que seleção/troca não estavam visíveis nem possuíam ação na tela Standalone. A implementação compactou e centralizou o painel unificado de acervo/catálogo, que ocupava toda a altura. Nenhum backend/IPC ou funcionalidade de biblioteca/catálogo foi removido.
- `src/standalone-player.css`: conteúdo dimensionado pelo conteúdo, centralizado na área útil, mantendo biblioteca e catálogo lado a lado dentro do painel existente; sem zoom global.
- `tests/standalone-player-production-electron.ts`: assertions de ausência de painel/ação de modo, presença dos controles de biblioteca, refresh, CSV, relatório/toast, painel compacto, centralização e ausência de overflow; captura posterior.
- Linux: compile, `test:unit:standalone-ui`, E2E de Opções, biblioteca, catálogo e produção — PASS. Capturas antes/depois: `/tmp/kq-standalone-c1-captures-jf1GrR/c8-options-indexed-and-catalog-absent.png` e `/tmp/karaoke-queue-standalone-production-screenshots-1895622/c10.2-options-after-1280x800.png`.
- Windows: E2E de Opções e produção — PASS no runner oficial, com Electron, Playwright, IPC, MP4, SQLite/recovery isolados e snapshot validado em staging NTFS `E:\source\karaoke-queue-win-c9c10-validation-04` (`branch=feature/remote-player-lan-integration`, `HEAD=1404da0d55fb2672cccab065f8af5df0cfa05e5d`, fingerprint `caea0d4016b95ed5ae222ab01108fed784546872e4cd40fbd78e482c4beb750b`). Captura posterior: `C:\Users\Chris\AppData\Local\Temp\karaoke-queue-standalone-production-screenshots-10232\c10.2-options-after-1280x800.png`.
- A seleção nativa de arquivos não foi exercitada: o harness utiliza uma porta de diálogo exclusiva de teste. A comparação antes/depois não mostrou espaço vazio ou desalinhamento. A aprovação final do proprietário refere-se à experiência visual C10 e não altera essa limitação funcional da automação de diálogo.

### C10.3 — Auditoria de resoluções e escalas do Windows

**Status:** Concluída tecnicamente; testes físicos de TV/overscan não disponíveis neste ambiente.

**Descrição:** Identificar e documentar problemas comprovados antes da adaptação, sem misturar a auditoria com a correção.

**Execução registrada:**
- A auditoria inicial encontrou que, embora não houvesse overflow nem corte nas viewports medidas, em 3840×2160 rótulos de estado, campo e metadados continuavam em 14/15 px CSS, iguais aos de 1280×800. Esse foi o problema comprovado de legibilidade em tela grande.
- Foram registrados os tamanhos 1280×800, 1366×768, 1920×1080, 2560×1440 e 3840×2160, além dos estados idle, Desconectado, menus, comandos/keycaps, Opções, modal, loading, countdown, reprodução/fila, pausa, celebração e fullscreen.
- As métricas iniciais estão em `/tmp/karaoke-queue-standalone-production-screenshots-1901878/c10.3-before-metrics.json`. Nenhuma correção foi classificada como parte desta auditoria.

### C10.4 — Adaptação responsiva

**Status:** Concluída tecnicamente; a implementação responsiva foi antecipada na antiga C10.3 e verificada sem alterações cosméticas adicionais. A experiência foi aprovada pelo proprietário como parte do encerramento da C10.5 em 2026-11-06.

**Descrição:** Corrigir os problemas registrados em C10.3, preservando identidade visual, proporções e designs aprovados. O registro da execução anterior classificou a adaptação dentro da antiga C10.3 e declarou C10.4 não iniciada como subetapa separada; a reorganização preserva esse fato e não representa nova execução.

**Execução e resultados registrados:**
- `src/standalone-player.css` usa escala progressiva por faixas de largura (`1`, `1.125`, `1.25`, `1.5`, `2` e `2.4`) para componentes, textos, espaçamentos, ícones, menus, overlays e Opções; não aplica zoom global. Em 3840×2160 os rótulos auditados passaram a 33,6/36 px, enquanto 1280×800 manteve 14/15 px.
- As cinco dimensões CSS foram exercitadas em Electron real no Linux, com viewport/BrowserWindow real; DPR 1, 1.25, 1.5, 1.75 e 2. A proporção do vídeo MP4 foi preservada; não foram observados overflow, cortes ou regressão de 1280×800 nos estados cobertos.
- Linux: `npm run compile`; `test:unit:standalone-sequence` (69), `test:unit:standalone-runtime` (57), `test:unit:standalone-ui` (122), E2E UI, biblioteca, catálogo e produção Standalone — PASS.
- Windows nativo: runner oficial `npm run test:e2e:standalone-production:windows -- --approve-untracked` — PASS em staging NTFS `E:\source\karaoke-queue-win-c9c10-validation-04`, snapshot `feature/remote-player-lan-integration`, HEAD `1404da0d55fb2672cccab065f8af5df0cfa05e5d`, fingerprint `bb673bde3077a9ba81d23e84661fad8455e5d674e7d78b7039c7db5b015926a1`. Electron/Playwright, MP4 e SQLite nativos. Tamanhos CSS foram exercitados por viewport CDP, sem afirmar que o monitor físico foi redimensionado; o host estava em escala Windows 125%; DPRs foram emulados por CDP. Fullscreen nativo foi testado no monitor disponível.
- Capturas/métricas pós-correção: Linux `/tmp/karaoke-queue-standalone-production-screenshots-1938994/`; Windows `C:\Users\Chris\AppData\Local\Temp\karaoke-queue-standalone-production-screenshots-33660\`. O arquivo `c10.3-after-metrics.json` registra viewport, DPR, tamanhos de texto, overflow e cortes.
- **Verificação específica C10.4 — 2026-11-06:** foram reutilizados os métricos anteriores e executados novamente os E2Es de produção Windows e Linux; nenhum CSS foi alterado. As cinco viewports (1280×800, 1366×768, 1920×1080, 2560×1440 e 3840×2160) têm `scrollWidth/scrollHeight` iguais à viewport e `clipped: []` nos estados auditados (ocioso/Desconectado, menu, comandos/keycaps, Opções e modal). As fontes dos rótulos sobem de 14/15 px CSS em 1280×800 para 21/22,5 px em 1920×1080, 28/30 px em 2560×1440 e 33,6/36 px em 3840×2160. DPR 1, 1,25, 1,5, 1,75 e 2 foram exercitados em viewport 1280×800; são emulações CDP, não mudança da escala global do Windows. A execução Linux capturou viewports CSS e fullscreen 1280×1024 em display virtual 4000×2300, escala 1. A execução Windows capturou as cinco viewports em Electron sob escala nativa observada de 125% e fullscreen no monitor disponível em 2752×1152; DPRs foram emulados por CDP. Foram inspecionadas imagens reais dos dois sistemas em 1280×800 idle, 3840×2160 idle, 3840×2160 Opções e fullscreen Windows: sem overflow/cortes visíveis e com tipografia/componentes proporcionais. Capturas finais Linux: `/tmp/karaoke-queue-standalone-production-screenshots-1979937/`; Windows: `C:\Users\Chris\AppData\Local\Temp\karaoke-queue-standalone-production-screenshots-35480\`. A execução também capturou reprodução, fila, pausa, celebração, menus e modal.
- O Electron Linux da evidência responsiva usou display virtual 4000×2300, escala 1, e viewports redimensionadas; isso não equivale a monitores físicos nessas cinco resoluções. A evidência Windows anterior veio do runner nativo em janela/fullscreen, escala de sistema observada em 125%, e viewports CSS ajustadas no Electron. Escalas Windows globais 100%, 150%, 175% e 200% e TV/overscan físicos não foram testados. O proprietário confirmou que redimensionar a janela reorganiza e amplia os elementos corretamente. Considerando as métricas sem overflow/corte, a legibilidade escalonada, os estados e fullscreen já cobertos, a implementação atende tecnicamente C10.4; a validação final comparativa e a aprovação humana continuam em C10.5.

### C10.5 — Validação visual final

**Status:** Concluída e aprovada explicitamente pelo proprietário em 2026-11-06. A aprovação considera satisfatória a interface visual e a adaptação responsiva atuais, com base nas evidências existentes e na validação manual de redimensionamento previamente relatada.

**Descrição:** Validar capturas reais do Electron em relação ao Doop nas resoluções relevantes, além de fullscreen e redimensionamento de janela. Na execução anterior, as tarefas de validação faziam parte da antiga C10.3; eram relatadas como não iniciadas enquanto etapas autônomas C10.5. A evidência correspondente é mapeada abaixo sem declarar aprovação humana nem nova execução.

**Execução e limitações:**
- O proprietário aprovou explicitamente a C10.5 nesta interação e encerrou a C10. Não foi solicitada nem executada nova auditoria de responsividade, nem foram feitas alterações CSS/layout nesta subetapa. As limitações de monitor físico, escalas Windows adicionais e TV/overscan permanecem registradas e não impediram a aprovação.
- Capturas reais de Electron foram verificadas nos cinco tamanhos. Em 1280×800, estados ocioso e Opções foram comparados com a identidade visual Doop aprovada; as demais dimensões foram verificadas quanto a composição, legibilidade, cortes, alinhamento e métricas, pois os frames C10 são referências de 1280×800.
- A descrição, HTML editável e renderização dos quatro frames C10.1 foram consultados no Doop MCP. O modal C9 foi comparado com o frame `MdDG5yAHUb`; após investigar captura anterior sem botões, ambos os botões voltaram a aparecer na renderização consultada. Nenhum frame Doop foi alterado.
- A captura Loading é transitória: métricas síncronas no evento de transição confirmaram o cartão dentro de 3840×2160, mas não foi obtida screenshot estável para o estado. Esse resultado não é descrito como captura visual estável.
- Windows nativo testou a janela fullscreen no monitor disponível (viewport CSS 2752×1152, escala física observada de 125%). O host Windows não teve o monitor físico redimensionado nas cinco resoluções; as medidas foram verificadas pela viewport Electron/CDP. Escalas globais Windows 100%, 150%, 175% e 200% não foram testadas fisicamente; DPRs equivalentes foram emulados em CDP.
- Não houve TV física nem teste real de overscan/distância de sofá. Capturas/comparações técnicas não substituem revisão visual do proprietário.

**Critérios:** resultados funcionais, visuais e técnicos permanecem separados; comparações automatizadas/de agente não são aprovação humana. A aprovação explícita do proprietário encerra C10.5/C10. C9 foi posteriormente concluída e aprovada pelo proprietário em 2026-11-07, sem novos testes.

## Decisões aprovadas

- A ordem C10.1 → C10.2 → C10.3 → C10.4 → C10.5 é obrigatória.
- C10.3 identifica/documenta problemas; C10.4 implementa adaptações; C10.5 valida os resultados.
- 1280×800 permanece referência visual; C10 não implementa comunicação remota e não altera frames Doop.

## Pendências e riscos

- **Registro histórico anterior ao encerramento global de C9:** a avaliação visual humana C9.2/C9.5 ainda aguardava decisão naquele checkpoint. O proprietário posteriormente concluiu/aprovou C9 e a Fase C em 2026-11-07, sem exigir nova validação. C10.5 foi aprovada pelo proprietário; as limitações físicas listadas abaixo não impedem essa aprovação.
- Sem TV física/overscan; escala física Windows observada foi 125%. DPR simulado por CDP não equivale a alterar escala global Windows.
- Os tamanhos CSS no runner Windows não equivalem a redimensionar fisicamente o monitor em cada resolução.

## Histórico de execução

O histórico anterior concluiu C10.1–C10.3 no escopo então aprovado. A adaptação responsiva e as capturas/comparações de validação foram realizadas dentro da antiga C10.3, embora C10.4/C10.5 tenham sido registradas como não iniciadas enquanto etapas independentes. Esta reorganização transfere as evidências às responsabilidades C10.3, C10.4 e C10.5 sem repetir a execução. Em 2026-11-06, o proprietário aprovou explicitamente a experiência atual e encerrou C10.5/C10. O registro à época não encerrava C9; posteriormente, em 2026-11-07, o proprietário concluiu e aprovou C9 e a Fase C, sem exigir nova validação.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Planejamento da interface Standalone](../../standalone-player-ui-plan.md)
- Referência Doop MCP: canvas `wq3cerR6M7`, quatro frames identificados com `C10.1` (nenhum frame foi alterado).
