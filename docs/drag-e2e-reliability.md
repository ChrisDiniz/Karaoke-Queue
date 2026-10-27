# Prioridade 4 — confiabilidade do E2E de drag-and-drop

## Diagnóstico observado

A falha foi reproduzida na automação, sem evidência que justificasse alterar o controlador de produção.

O helper antigo da suíte completa capturava coordenadas antes do arraste, soltava a 2px da borda do destino e usava esperas fixas. A prévia usa FLIP/Web Animations: cards e alvos mudam de posição. No registro da reprodução, o movimento para o destino atravessou elementos filhos e terminou em `dragenter`/`dragleave`, sem um `dragover` final aceito. Uma prévia visível não comprova que o drop foi aceito. O controlador corretamente não confirma um movimento terminado com `dropEffect=none`.

Os testes isolados usavam outra sequência (`locator.dragTo`), enquanto o completo combinava coordenadas próprias, zoom, rolagem e animações após cancelamentos. Isso explica a diferença de cobertura e comportamento; não constitui evidência de estado funcional residual.

Outros problemas de sincronização identificados na ampliação da cobertura:

* `.sidebar-brand-name`: aguardar a classe `is-expanded` não aguarda a expansão visual. O texto ainda podia ter largura zero. Agora o teste aguarda visibilidade e compara com a preferência real, não com um nome fixo.
* Arraste bloqueado: `dragTo` entre cards distantes podia rolar a lista antes do início efetivo do arraste e iniciar em outro card. O teste agora verifica um `dragstart` nativo, cancelado, no ID congelado correto, além do aviso e da preservação do bloco.

* Preservação de rolagem no histórico: o teste media scrollTop antes de `locator.click()` trazer “Ver mesa” à área visível. Agora posiciona o botão e aguarda estabilidade antes de medir a rolagem, preservando a asserção após abrir/fechar o modal. Isso apareceu ao substituir o auto-scroll sintético por mouse real.

### Auto-scroll nativo e Escape na borda

A substituição do `DragEvent` sintético por mouse real expôs outro comportamento reproduzido isoladamente: no Electron/Chromium testado, cancelar o drag interceptado pelo Playwright com o ponteiro ainda na borda pode deixar o auto-scroll nativo ativo. Após Escape e mouse.up, medições por animation frame foram `17,17,…,30,43,56,69,82`. Mover o cursor depois de cancelar não resolveu (`73,…,86,99,112,125,138,151`). Sair da região de auto-scroll ainda durante o arraste e então pressionar Escape produziu valores constantes (`56` em todas as 15 amostras).

O teste de fila longa agora comprova auto-scroll real, move o cursor para o centro (finalizando a condição de auto-scroll) e cancela com Escape. Mantém a verificação da restauração exata da ordem e limpeza do estado, sem manipular timers ou disparar eventos artificiais. A suíte também testa Escape sem esse movimento nas prévias comuns, fora da borda. Essa limitação foi comprovada com a automação CDP; comportamento com mouse nativo no Windows não foi estabelecido. Logs do experimento: `/tmp/probe-native-scroll-after.log`.

## Solução nos testes

`tests/drag-diagnostics.ts` centraliza a sequência real de mouse:

1. Aguardar confirmação das operações pendentes via `flushState()` e fim das animações.
2. Capturar IDs e resolver locators estáveis, sem reutilizar `first/last` durante reordenação.
3. Colocar a origem visível e estável; iniciar o arraste com mouse.
4. Colocar o destino visível; enviar dois movimentos no destino, permitindo `dragenter` seguido de `dragover` aceito pelo Chromium.
5. Aguardar o placeholder na posição desejada e o fim das animações.
6. Soltar dentro do espaço de inserção, cuja posição foi medida novamente.
7. Comprovar `drop` nativo (`isTrusted`) e aceito (`defaultPrevented`) antes de aguardar o modal.

Não há retry de arraste, aumento de timeout, eventos `DragEvent` fabricados ou chamada ao controlador para simular movimentações. As únicas consultas internas aguardam durabilidade já existente. O helper também verifica ausência de classes temporárias e modal após Cancelar/Escape.

A suíte completa passa a usar o helper compartilhado. O teste isolado cobre cancelamento → Escape → confirmação; movimentos para cima/baixo; mover pin; soltar e mover novamente; região dinâmica com congelamento; bloqueio do card congelado; adicionar/concluir/cancelar antes de arrastar; escala 125%; confirmação de pins diretamente no SQLite e recuperação após reinício. A comparação dos pins ignora somente a ordem das chaves JSON, mantendo IDs e posições exatos.

## Diagnóstico de falhas

Traces por execução do Electron, screenshots durante a prévia, IDs e caixas de origem/destino, ordem dos IDs, eventos e `dropEffect`, elemento sob o cursor, visibilidade de overlays/modal, classes temporárias e erros do renderer são gravados exclusivamente em diretórios temporários de teste. Não se adicionou logging de produção.

Comandos:

```sh
npm run test:unit
npm run test:e2e:drag:headless
npm run test:e2e:headless
npm run test:e2e:round-robin:headless
npm run test:e2e:cadence:headless
npm run test:e2e:persistence:headless
```

Para cinco execuções sem retries: compilar uma vez e executar `build/tests/electron-smoke.js` cinco vezes sob Xvfb. Cada processo cria seu próprio perfil SQLite. Não recompilar enquanto suites Electron estiverem ativas: elas reiniciam o aplicativo e precisam dos mesmos artefatos de build.

## Escopo e limites

Nenhuma alteração de produção nesta correção: controlador de drag-and-drop, persistência, Round Robin, cadência, sessões, UI e schema permanecem como estavam. A limpeza de cancelamentos é verificada pela ordem publicada, estado SQLite, modal e classes transitórias, seguida de novo arraste bem-sucedido. Não há evidência de flags residuais interferindo no fluxo testado.

A validação usa Electron/Chromium real em Linux/Xvfb, SQLite via IPC e consulta direta ao banco. Não substitui validação nativa do mouse/driver e DPI no Windows. Traces e screenshots usam dados fictícios de teste. Nenhum perfil real foi usado.

## Resultados de regressão

| Suíte | Resultado |
| --- | --- |
| Unitários (`npm run test:unit`) | 126 testes aprovados, zero falhas |
| Isolado drag A–N | Aprovado; `/tmp/karaoke-drag-e2e-8GuOUF` |
| Round Robin Electron | Aprovado; `/tmp/karaoke-rr-evidence-OwLU8I` |
| Cadência/Duda Electron | Aprovado; `/tmp/dnd-regression-debut-cadence-electron.log` |
| Persistência com falhas Electron | Aprovado; `/tmp/karaoke-persistence-tpqwhM` |
| Sessões anteriores Electron | Aprovado; `/tmp/dnd-regression-history.log` |
| Fechamento/recuperação de sessões Electron | Aprovado; `/tmp/dnd-regression-session-close.log` |

Os hashes de `queue-rules.ts`, `debut-cadence-rules.ts`, `round-robin-rules.ts`, `fixed-turn-rules.ts` e `frozen-queue-rules.ts` conferem com o registro anterior às alterações desta prioridade.

As primeiras execuções de diagnóstico falharam na sidebar, prévia sem aceitação, arraste bloqueado com origem incorreta e medição de rolagem, conforme detalhado acima. Uma campanha intermediária foi interrompida deliberadamente para eliminar o auto-scroll sintético; ela não conta na aceitação final.

Campanha final: **5/5 execuções completas consecutivas aprovadas**, sem retries ou intervenção. Cada execução iniciou com perfil temporário SQLite independente e reabriu o Electron oito vezes. Todas percorreram a suíte até a mensagem final de aprovação.

| Execução | Resultado | Evidências (screenshots, eventos e traces) |
| --- | --- | --- |
| 1 | PASS | `/tmp/karaoke-smoke-evidence-qhZjRk` |
| 2 | PASS | `/tmp/karaoke-smoke-evidence-Ta6sBx` |
| 3 | PASS | `/tmp/karaoke-smoke-evidence-l2bXDZ` |
| 4 | PASS | `/tmp/karaoke-smoke-evidence-A0nB9K` |
| 5 | PASS | `/tmp/karaoke-smoke-evidence-5r87p2` |

Total: **40 drops nativos aceitos**, todos com `dropEffect=move`, `isTrusted=true` e `defaultPrevented=true`; 40 traces (oito janelas por execução); nenhuma classe temporária de drag remanescente nos registros finais. Cancelamentos e dragstart bloqueado corretamente não geram drop aceito.

Logs: `/tmp/dnd-acceptance-1.log` a `/tmp/dnd-acceptance-5.log`. Manifesto com hashes dos testes e contagens verificadas: `/tmp/dnd-acceptance-results.json`.

Ambiente: Electron 45.0.0, Playwright 1.64.1, Node 24.15.0, Linux/Xvfb. Screenshots durante a prévia e após recuperação também em `/tmp/karaoke-drag-e2e-8GuOUF`; traces `before-restart.zip` e `after-restart.zip`.

## Matriz de cobertura

| Requisito | Evidência automatizada |
| --- | --- |
| A–E: confirmar, cancelar, Escape, nova tentativa e movimentos sucessivos | `drag-electron.ts`: prévia vs ordem final, banco inalterado após cancelar/Escape, novo drop aceito |
| F–G: mover pin, soltar e mover novamente | Posição por ID no JSON de pins do SQLite |
| H: bloco congelado | Ordem dos IDs congelados preservada; dragstart nativo bloqueado; movimento na região dinâmica |
| I–K: depois de cadastro, conclusão e cancelamento | Novo movimento após aguardar publicação/durabilidade de cada operação |
| L: reinício | Comparação integral de entries/app_state, normalizando somente ordem das chaves do objeto JSON de pins |
| M: escala | Teste isolado em 125%; completo também exerce prévia em QHD/escala automática |
| N: persistência assíncrona | `settleQueue` aguarda `flushState`; ordem exibida comparada com ordem efetiva recuperada do SQLite |
| Auto-scroll | Mouse real na borda inferior, aumento de scrollTop, Escape restaura a ordem |
| Sidebar | Visibilidade após transição e nome igual à preferência persistida |

O teste completo continua incluindo as verificações de fila, histórico, modal de mesas, congelamento/extensão/liberação, menus, escala e reabertura. Não se removeu cobertura para alcançar o trecho de drag-and-drop.

## Arquivos desta prioridade

* `tests/electron-smoke.ts`: sincronização da sidebar, confirmação de persistência, helper compartilhado, auto-scroll por mouse real, medição de rolagem e coleta de traces/diagnóstico.
* `tests/drag-diagnostics.ts`: observação de eventos, sequência de mouse estável, asserção de limpeza e rejeição de origem congelada.
* `tests/drag-electron.ts`: cenários A–N com Electron/SQLite e reabertura.
* `package.json`: comando `test:e2e:drag:headless`.
* `docs/drag-e2e-reliability.md`: diagnóstico, reprodução e resultados.
