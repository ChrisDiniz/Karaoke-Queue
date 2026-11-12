# G/H — Sequência incremental e matriz de validação

## Estado e uso

Planejado / Não iniciado em 2026-11-11. Nenhum comando de teste/aplicativo executado nesta rodada. A sequência é proposta para autorizações futuras, não ordem de execução já autorizada. [Contrato](paired-mode-contract.md), [interfaces](paired-mode-ui-plan.md), [roadmap](standalone-player-roadmap.md). F encerrada, sem alterações nesta tarefa.

G1–G6 e H1–H8 mantêm IDs e nomes de arquivo. Não foram necessários tickets novos: os novos trabalhos estão em subdivisões estáveis dentro da etapa proprietária. As tabelas abaixo orientam a execução; os tickets detalham pré-requisitos, módulos, contratos, interfaces, riscos, aceite e autonomia por lote.

## Sequência sem ciclos

| Ordem | Etapa/lotes | Entrega | Gate para concluir/avançar |
|---|---|---|---|
| 1 | G1.1 | Estratégia revisável de confiança/identidade/transporte | Revisão T1; primeira tarefa a autorizar, sem abrir rede |
| 2 | G1.2–G1.3 | Transporte seguro Main-only e ciclo de vida | Segurança, limites, cleanup Linux/Windows; aprovação G1 |
| 3 | G2.1–G2.3 | Vínculo de Controller único e autorização | Revogação/restart; UI de confiança desenhada após T1 e aprovada; aprovação G2 |
| 4 | G3.1 | Schemas executáveis de IDs, pacote, operações, journal e snapshot | Compatibilidade testada com IDs reais; sem regras de fila |
| 5 | G3.2 | Proposta T2 e store isolado durável | Revisão de store/retention antes de codificar; crash/disco cheio |
| 6 | G3.3–G3.4 | Outbox/consulta, ACK durável, replay e compactação | Dedupe resiste a restart/limpeza; aprovação G3 |
| 7 | G4.1–G4.4 | Reconexão/uncertainty/fences/recovery técnicos | Sem autoplay/replay cego/deadlock; aprovação G4 |
| 8 | G5.1–G5.3 | Estados reais de conexão/operação e avisos de protocolo | Revisão de drafts usados, comparação Electron/Doop e aprovação G5 |
| 9 | G6.1–G6.3 | Evidência de mecanismos em dois computadores | Segurança e faults reais; aprovação G, não operação H |
| 10 | H1.1 | Consulta de disponibilidade/cadastro | MP4 sem CSV, timeouts e resposta velha; D5 resolvida: inexistente comprovada bloqueada conectado; offline não verificado permitido; regressões Gestão |
| 11 | H1.2–H1.3 | Ocorrências/projeção e promoção separada | D1/D4 resolvidas: rotação existente preservada e promoção automática após terminal elegível; migração aditiva/SQLite real; aprovação H1 |
| 12 | H2.1–H2.2 | Aceitação e execução da vez de 1–2 músicas | Sem ativação dupla; apresentação única/celebração correta |
| 13 | H2.3–H2.5 | Comandos, troca e resultados duráveis no Player | Corridas, contenção e falhas; revisão H2 |
| 14 | H3.1–H3.2 | História/cursor, pendências e reconciliação operacional | Idempotência SQLite, replay/crash/EOF concorrente |
| 15 | H3.3–H3.4 | Offline, retorno e takeover | Suspender fila local; offline só sem vez ativa (D3 resolvida); destino final da fila suspensa ainda depende de D2; aprovação H3 |
| 16 | H4.1–H4.5 | Integração visual final Gestão/Player | Estados e frames revisados; comparação real Electron/Doop; aprovação humana H4 |
| 17 | H5.1–H5.3 | E2E completo + dois computadores | Homologação funcional/visual/técnica explícita |
| 18 | H6.1–H6.5 | Baseline/endurance/acervos/otimizações por evidência | Preservar campanhas e métricas existentes; aprovação H6 |
| 19 | H7.1–H7.3 | Primeiro release controlado remoto | Autorizações individuais de build/distribuição/publicação/instalação e testes pelo proprietário |
| 20 | H8.1–H8.3 | Adapter local Combined | Só após H7; preservar operação remota; aprovação H8 |

G2 usa os conceitos do contrato já descrito nesta rodada, não depende da implementação G3.1. G3 schemas executáveis dependem da infraestrutura aprovada, sem pedir que G2 importe módulo futuro. H2 usa ports journal/rede de G, H3 usa eventos de H2, H4 usa comandos de H2/H3; nenhum deles é pré-requisito de G6. Para H2 testar a apresentação sem antecipar a UI H4, usar port/view-model e relógio controlado; montagem visual aprovada em H4. Shell de teste não equivale à aplicação de produção.

Cada linha representa capacidade nova **planejada**, nunca capacidade já existente. Módulos, contratos exatos, UI e risco estão explicitados no ticket correspondente e no contrato §2–§3. UI original aprovada que conflita com a nova regra exige variante/revisão, não autorização tácita de alteração.

## Matriz resumida por proprietário

| IDs de teste planejados | Etapa | Cenários e oráculo |
|---|---|---|
| SEC-01–05 | G1/G2/G6 | TLS inválido, versão desconhecida, autenticação falha, peer não autorizado, Controller concorrente/revogado: zero efeito |
| PRO-01–05 | G3 | Duplicata, payload conflitante, ACK perdido, reordenação e mensagem velha: uma intenção/resultado, nenhuma ação na próxima ocorrência |
| DUR-01–06 | G3/G4 | Crash antes/depois de commit/efeito, resultado persistido não recebido, falha de escrita, lacuna/cursor, compactação/backup: preservar prova e nunca confirmar EOF ausente |
| REC-01–05 | G4/G6 | Timeout, operação enviada desconhecida, reconnect, restart de peers e mudança de epochs: consultar ID original; nenhuma nova intenção Avançar automática |
| UI-01–04 | G5/H4 | Estado real, spinner limitado/unknown, foco/teclado e captura no tamanho de referência; nenhuma janela pausa música |
| MED-01–04 | H1/H2 | MP4 sem CSV selecionável; consulta velha/timeout; segunda música ausente bloqueia aceite; mídia removida entre consulta/aceite/playback é revalidada |
| TURN-01–06 | H2 | Turno enviado duas vezes (mesmo/novo operationId), primeira após idle com uma apresentação 5 s, segunda automática, sem celebração intermediária, EOF última com celebração 5 s, cancelamento última sem celebração |
| RACE-01–06 | H2/H3 | EOF×Avançar; local×remoto; troca×EOF; modal atrasado; reconnect×EOF; EOF×takeover: uma transição válida e alvo seguinte intacto |
| TRANS-01–04 | H2/H3 | Queda durante apresentação mantém execução; reconnect durante celebração não duplica timer; falha entre músicas preserva EOF1; fila futura alterada não modifica vez aceita |
| HIST-01–05 | H1/H3 | Evento aplicado/cursor/ACK atômicos; resultado misto conforme D1; origem manual explícita; sessão antiga isolada; D4 sem promoção dupla |
| MODE-01–06 | H3 | Stop All preserva fila futura e EOF anterior; offline explícito; retorno sem reassumir; aguardar local; takeover imediato após contenção; destino local conforme D2 e caso ativo conforme D3 |
| DEC-01 | H1/H3 | D1: uma cantada/uma cancelada preserva resultados individuais e semântica existente de rodadas, rotação, estreia/cadência; comparar com regras atuais, sem nova contagem |
| DEC-02 | H3/H4 | D2: takeover aguardar/imediato suspende fila local com itens distintos preservados; nenhuma importação, descarte ou execução automática; retorno/descarte final permanece fora do aceite até decisão |
| DEC-03 | H3/H4 | D3: negar offline em apresentação/loading/playing/paused/transição da vez; aguardar terminal ou Stop All explícito/confirmado; cancelar modal não muda modo e falha de contenção mantém bloqueio; corrida aceite×offline serializada |
| DEC-04 | H1/H3 | D4: EOF última e Avançar última promovem pelo Round Robin uma única vez, inclusive replay/ACK perdido; Stop All não promove; fila vazia retorna idle; celebração não sobrepõe apresentação |
| DEC-05 | H1/H2 | D5: inexistente comprovada com conexão bloqueia cadastro; MP4 sem CSV não bloqueia; offline admite não verificado; timeout/unknown não vira inexistência nem confirmação de mídia; revalidar antes do playback |
| REG-01–05 | H1–H5/H8 | Round Robin por mesa, cadência 2:1, pins/frozen, sessões/SQLite e Standalone independente preservados; cancelamento nunca equivale a cantada |
| SYS-01–03 | G6/H5 | Dois computadores reais: transporte/segurança G6 separados de domínio/operação H5; shutdown/cleanup de ambos; divergências/limites documentados |
| PERF-01–03 | H6 | Endurance/acervos/telemetria já aprovados, mais crescimento do journal/outbox e custo de reconciliação; sem TTL destrutivo |
| REL-01–02 | H7/H8 | Compatibilidade/atualização e pacote autorizado; depois adapter local com regressão remota |

IDs são grupos planejados, não testes já adicionados ou resultados PASS. Criar casos unitários por transição/erro e integração nas fronteiras; não criar teste que só espelha implementação.

## Ambientes e CI

- Linux: unitários determinísticos com relógio/barreiras; store real isolado, rede sintética com atraso/perda/duplicação/reordenação e Electron real com mídia de teste.
- Windows: runner oficial WSL → snapshot NTFS → Node/Electron/Playwright nativos, perfis/bancos isolados, MP4 real quando playback importa. Registrar SHA/fingerprint e cleanup; não executar aplicativo Windows do source WSL.
- CI: ampliar seletores existentes `npm run test:unit`, `test:e2e:linux` e runner nativo conforme scripts efetivamente disponíveis ao implementar. Reutilizar `.github/workflows/pr-validation.yml` e `release-windows.yml`; não criar workflow redundante, disparar publicação ou usar credenciais reais por efeito colateral. Testes de protocolo/rede usam peers locais e mídia fixture; distinguir isso de dois computadores.
- G6 e H5: duas máquinas reais, rede real, identidade/certificados e desconexões controladas. Sintéticos não comprovam comportamento de hardware/rede externa. H5 inclui MP4 e SQLite reais e Main de produção, não apenas harness.
- UI: capturas Electron e Doop nas dimensões correspondentes (Gestão 1440×920, Player 1280×800), correções significativas antes de pedir aprovação visual. DOM não substitui imagem. Resultado funcional, visual e técnico separados; A/V perceptível e homologação são humanos.
- Nenhuma campanha F, USB físico ou biblioteca real é necessária para esta rodada de planejamento. Testes de aplicação/compile/Electron/Windows: NOT RUN nesta rodada por ausência de mudança funcional.

## Autonomia e decisões

Pode-se delegar implementação, testes focados e revisão consecutivos **dentro do lote autorizado**, com ownership exclusivo e sem writes concorrentes em build/perfil/banco. Bons lotes fechados: schemas G3.1 após decisões de G1/G2; store G3.2 após T2; replay G3.4; reconexão técnica G4 após G3; consulta H1.1 segundo D5 aprovada; execução H2 após H1; testes determinísticos independentes e revisão read-only.

Não há autorização automática de avançar entre fases/subfases. Gates do proprietário: T1/T2 nas propostas técnicas; escolha final de descarte/retorno da fila suspensa em D2 antes desses destinos; aprovação visual dos drafts usados; G6/H5/H6 e entrega H7. H8 segue posterior. D1/D3/D4/D5 estão resolvidas; isso não dispensa adaptar os consumidores com testes. Não resolver a parte restante de D2 limpando ou reativando automaticamente a fila local.

Parecer: backlog pronto para começar pela **proposta G1.1**, após autorização. Ainda não está liberado para executar toda G/H autonomamente: os gates acima são explícitos. O contrato funcional aprovado já resolve a antiga pendência ampla de autoridade em G4; D1/D3/D4/D5 estão resolvidas; permanecem a parte final de D2, T1/T2 e aprovações de implementação/visual/homologação.

## Revisão documental desta rodada

Revisados contratos, distribuição G/H, dependências, frames/descrições e diff documental. Links locais dos novos documentos e tickets G/H (120 referências) e links das linhas adicionadas verificados sem ausências; IDs canônicos únicos e estados Planejado conferidos. Os 18 IDs novos constam da matriz e as 18 descrições externas correspondem às cópias preparadas. Doop confirmou 13 originais sem alteração de aprovação, data, posição ou tamanho; 18 novos permanecem draft. `git diff --check` PASS. Esses são checks documentais, não resultados dos testes planejados. Mudanças F preexistentes foram preservadas, sem edição nesta rodada.

## Encerramento das decisões funcionais D1–D5

O proprietário aprovou D1/D3/D4/D5 e a suspensão da fila local em D2 nesta sessão. Não há mais gates funcionais pendentes sobre rotação de vez mista, saída offline durante vez ativa, promoção automática ou cadastro de mídia comprovadamente inexistente/offline não verificado. D2 permanece parcialmente resolvida: somente descarte definitivo versus retorno da fila suspensa exige escolha posterior; isso não deve impedir os lotes independentes que preservam a suspensão. T1/T2 continuam exigindo revisão técnica. DEC-01–05 são testes previstos, não executados. Sem alteração de código/Doop ou início de G1.

Checkpoint documental autorizado explicitamente pelo proprietário ao encerrar D1–D5: consolidar a arquitetura inicial e o planejamento em commit local, com mensagem em inglês. Essa autorização substitui somente a restrição de commit nesta solicitação; não autoriza push, implementação, edição de frames ou início de G1. O encerramento F preexistente é preservado sem novas mudanças de conteúdo. Testes de aplicação continuam não executados por escopo documental e instrução do proprietário.
