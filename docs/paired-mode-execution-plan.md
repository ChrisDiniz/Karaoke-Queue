# G/H — Sequência incremental e matriz de validação

> Estado vigente — reauditoria focal independente Sol em 2026-11-13: **PASS**, A1–A4 confirmados corrigidos. G3 apta para checkpoint e tecnicamente apta para G4 mediante autorização própria. Produção não homologada. Histórico e limites em [relatório independente](g3-independent-audit.md).

## Aceite do proprietário — G1 homologada com limitações — 2026-11-12

O proprietário aceitou a G1 e determinou seu encerramento como **homologada com limitações**, após o parecer técnico independente favorável. G1.2 está concluída; G1.3 foi aceita com as limitações abaixo. Esse aceite substitui o estado anterior de “aguardando aceite final”; os resultados técnicos históricos permanecem preservados e a validação integral de todas as plataformas não é declarada.

- Windows nativo: NOT RUN; o runner oficial bloqueou o arquivo-fonte `src/remote-secret-protector.ts` pela heurística de nome sensível antes da sincronização. A execução nativa continua pendente.
- Empacotamento: smoke ASAR focado PASS; rebuild limpo pendente por indisponibilidade externa/DNS (`EAI_AGAIN github.com` na tentativa anterior).
- Multicast real local WSL: PASS; LAN entre computadores e plataformas nativas permanece para G6.
- E2E audiovisual com MP4: NOT RUN, sem fixture aprovada; não bloqueia o aceite da infraestrutura G1.

A G1 está tecnicamente apta para G2 e seu aceite pelo proprietário está registrado. G2 permanece não iniciada e depende de autorização própria. T2, D2 e os demais gates futuros permanecem vigentes. Nenhum resultado NOT RUN foi convertido em PASS. Este checkpoint não encerra a Fase G inteira.

## Estado e uso

Estado atualizado em 2026-11-12: T1 aprovada com serial X.509 de no mínimo 64 bits de entropia; G1.2-A–D implementadas e G1.3 parcialmente validada. O teste multicast real local passou após corrigir bind/origem; smoke focado do módulo atualizado em ASAR passou. Windows nativo e descoberta entre computadores permanecem pendentes; rebuild limpo foi bloqueado por `EAI_AGAIN github.com`, conforme a [proposta T1](g1-1-t1-secure-transport-proposal.md#18-implementação-g12g13--evidências-e-limites). G2–G6 e H permanecem não iniciadas. [Contrato](paired-mode-contract.md), [interfaces](paired-mode-ui-plan.md), [roadmap](standalone-player-roadmap.md). F encerrada, sem alterações nesta tarefa.

G1–G6 e H1–H8 mantêm IDs e nomes de arquivo. Não foram necessários tickets novos: os novos trabalhos estão em subdivisões estáveis dentro da etapa proprietária. As tabelas abaixo orientam a execução; os tickets detalham pré-requisitos, módulos, contratos, interfaces, riscos, aceite e autonomia por lote.

## Sequência sem ciclos

| Ordem | Etapa/lotes | Entrega | Gate para concluir/avançar |
|---|---|---|---|
| 1 | G1.1 | Estratégia revisável de confiança/identidade/transporte | [T1 aprovada](g1-1-t1-secure-transport-proposal.md); sem abrir rede |
| 2 | G1.2–G1.3 | Transporte seguro Main-only e ciclo de vida | G1.2-A–D implementadas; G1.3-A/B parcialmente validadas; multicast real local e smoke focado do módulo em ASAR PASS; rebuild limpo pós-correção bloqueado por rede; multicast entre máquinas e Windows nativo pendentes; segunda revisão independente confirmou os achados corrigidos; aceite final antes de concluir G1 |
| 3 | G2.1–G2.3 | Vínculo de Controller único e autorização | Revogação/restart; UI de confiança desenhada após T1 e aprovada; aprovação G2 |
| 4 | G3.1 | Schemas executáveis de IDs, pacote, operações, journal e snapshot | PASS; WSS raw, identidade e bounds validados; sem regras de fila |
| 5 | G3.2 | Store isolado durável e revisão quantitativa de quota | PASS técnico Linux/Windows; crash/recovery, backup e contenção SQLite verificados; sem dispatcher/playback |
| 6 | G3.3–G3.4 | Outbox/consulta; ACK durável, replay e compactação | G3.3/G3.4 PASS técnico Linux/Windows; pronta para auditoria independente; sem aprovação de produção |
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

Não há autorização automática de avançar entre fases/subfases. T1/T2 estão aprovadas e G3.1–G3.4 concluídas tecnicamente; G3 aguarda auditoria independente. G4 exige autorização própria após esse gate. Permanecem a escolha final de descarte/retorno da fila suspensa em D2 antes desses destinos, aprovação visual dos drafts usados, G6/H5/H6 e entrega H7. H8 segue posterior. D1/D3/D4/D5 estão resolvidas; isso não dispensa adaptar os consumidores com testes. Não resolver a parte restante de D2 limpando ou reativando automaticamente a fila local.

Histórico: a proposta T1 e a primeira tentativa de execução foram concluídas antes da decisão do proprietário sobre serial de 64 bits; essa tentativa encontrou um bloqueio e não alterou código. Estado vigente e evidências G1.2/G1.3 constam acima e na [proposta T1](g1-1-t1-secure-transport-proposal.md). T2 foi posteriormente aprovada e executada em G3.2–G3.4; a parte final de D2 permanece pendente.

## Revisão documental desta rodada

Revisados contratos, distribuição G/H, dependências, frames/descrições e diff documental. Links locais dos novos documentos e tickets G/H (120 referências) e links das linhas adicionadas verificados sem ausências; IDs canônicos únicos e estados Planejado conferidos. Os 18 IDs novos constam da matriz e as 18 descrições externas correspondem às cópias preparadas. Doop confirmou 13 originais sem alteração de aprovação, data, posição ou tamanho; 18 novos permanecem draft. `git diff --check` PASS. Esses são checks documentais, não resultados dos testes planejados. Mudanças F preexistentes foram preservadas, sem edição nesta rodada.

## Encerramento das decisões funcionais D1–D5 — registro histórico, 2026-11-12

O proprietário aprovou D1/D3/D4/D5 e a suspensão da fila local em D2 nesta sessão. Não há mais gates funcionais pendentes sobre rotação de vez mista, saída offline durante vez ativa, promoção automática ou cadastro de mídia comprovadamente inexistente/offline não verificado. D2 permanece parcialmente resolvida: somente descarte definitivo versus retorno da fila suspensa exige escolha posterior; isso não deve impedir os lotes independentes que preservam a suspensão. Naquele registro, T1/T2 ainda exigiam revisão técnica; T1/T2 foram aprovadas posteriormente e G3.2–G3.4 executaram T2, conforme o fechamento abaixo. DEC-01–05 são testes previstos, não executados. O registro original não alterou código/Doop nem iniciou G1.

Checkpoint documental autorizado explicitamente pelo proprietário ao encerrar D1–D5: consolidar a arquitetura inicial e o planejamento em commit local, com mensagem em inglês. Essa autorização substitui somente a restrição de commit nesta solicitação; não autoriza push, implementação, edição de frames ou início de G1. O encerramento F preexistente é preservado sem novas mudanças de conteúdo. Testes de aplicação continuam não executados por escopo documental e instrução do proprietário.

## Histórico da análise G1.1 — antes da aprovação T1

A análise detalha opções, threat model, identidade/certificado, confiança inicial G2, autorização deny-all, módulos e lotes G1.2-A–D/G1.3-A–C e testes T1-ID/SECRET/TLS/BOOT/AUTH/FENCE/INPUT/LIMIT/LIFE/BOUNDARY/PACK. Naquela etapa a T1 ainda aguardava aprovação e os testes não foram executados. O estado atual de autorização e bloqueio consta acima; T2 e D2 parcial continuam intactos. Nenhuma implementação/commit ocorreu.

## Histórico da revisão incremental LAN — antes da aprovação T1

[Contrato técnico LAN](g1-1-t1-lan-pairing.md) substitui caminho manual/arquivo/QR. Acrescentar aos lotes sem renumeração: G1.2 contratos/discovery/TLS-bootstrap restrito; G1.3 limites/falsos anúncios/lifecycle; G2.1 perfil SRP/binding e revisão independente; G2.2 fluxo consentido/persistência; G2.3 falhas/revogação/renovação; G4.1 reconexão automática por identidade pinada/backoff; G5.4 UI guiada e H4 integração operacional. G2 testa consentimento via port, G5 monta UI final após G1–G4, sem dependência circular ou pairing de produção com fake UI.

Grupos DISC/PAKE/CONSENT/DURABLE/RECONNECT/RENEW/UI/RESOURCE do complemento integram a matriz futura. Vetores e MITM de PAKE não são substituídos por unitários mockados; multicast/firewall requer dois computadores Windows/Linux quando apropriado. Naquele registro histórico, G1.2/G1.3 estavam autorizadas, mas nenhum teste de aplicação foi executado: a inspeção encontrou o bloqueio do serial X.509 antes do código. O proprietário resolveu depois esse bloqueio e autorizou a implementação; veja o status vigente no início deste plano e na proposta T1. G2.1 continua exigindo revisão de encoding/binding antes de pairing de produção; não alegar biblioteca auditada.

## Retomada G3.1 — análise anterior, 2026-11-12

Registro histórico da análise documental antes da autorização de schemas executáveis. Seu status parcial e gates de aprovação foram superados pela implementação registrada abaixo; preservar o checkpoint G2 verificado e os limites de produção.


## G3.1 executável — estado antes do fechamento WSS (histórico)

O registro inicialmente marcou remote-infrastructure como NOT PASS/timeout e WSS raw como pendente. Foi corrigido depois: causa ambiental listen EPERM no sandbox, runner fora do sandbox PASS 20/20 e parser WSS integrado. Ver seção “G3.1 — integração WSS e conclusão” no fim deste plano.


## G3.1 — integração WSS e conclusão, 2026-11-12

Scanner raw integrado antes de JSON.parse no WSS; todos os envelopes pós-handshake destinados ao port validam schema e identidade autorizada. `npm run test:unit:operational-protocol` 8/8, pairing-wire 3/3 e remote-infrastructure 20/20 PASS. A falha antiga decorreu de `listen EPERM` no sandbox; fora dele a suíte fecha em ~4 s. Windows oficial NOT RUN: checkout NTFS não configurado. Sem store ou dispatcher; quotas T2 seguem provisórias. G3.1 PASS, G3.2 não iniciada.

## G3.2 — journal operacional durável, 2026-11-12

Store `node:sqlite` Main-only implementado e testado. Limites de admissão após medição: 256 MiB lógicos e 1.000.000 de registros totais; WAL/DB/backup físicos são estimativas. Testes store 14/14, contrato 8/8 e remote-infrastructure 20/20 PASS em Linux e Windows nativo pelo runner oficial; pairing-wire 3/3 e runner unitário 40/40 PASS em Linux. A suíte WSS encontrou no Windows uma desconexão 1006 em oversized; handler corrigido para preservar close 1009 e regressão passou. Backup/recovery sempre falha fechado; `max_page_count` simula espaço cheio. Não há dispatcher, outbox, compactação, playback ou fila paralela. G3.3/G3.4 seguem gated por autorização própria.

## G3.3 — dispatcher e outbox, 2026-11-12 (registro intermediário)

G3.3 PASS Linux. Dispatcher Main-only usa o WSS/G1 e autorização vigente G2, exige fence síncrono do estado do Player, persiste pelo journal antes de chamar executor sintético e nunca integra playback. Outbox Management no SQLite existente persiste intent antes da transmissão e preserva ID em retries; status incerto não vira falha terminal. Pairing OPAQUE + TLS pinado + WSS em processos independentes comprovou perda de resposta, retry e dedupe. Dispatcher/outbox 8/8, protocolo 9/9, store 14/14, migração 11/11, remote-infrastructure 20/20, pairing-wire 3/3 e runner unitário 40/40 PASS Linux. G3.4 será iniciada no mesmo mandato combinado, após este gate; Windows fica para o fechamento final.

## G3.4 — ACK, replay e compactação, 2026-11-13

G3.4 PASS técnico. O journal Player único persiste ACK de consumo autenticado, monotônico e idempotente; pagina eventos contíguos e limitados; grava checkpoint antes do snapshot; e compacta apenas no limite seguro entre cursores, checkpoint e high-watermark, sem remover tombstones nem evidência accepted/unknown. A Gestão usa o SQLite existente, migration v8, para inbox de páginas/snapshots. Seu cursor é de recebimento durável; não representa aplicação de fila/histórico e não produz ACK automático. H3 deve aplicar estado de negócio e cursor atomicamente antes de ACK.

Linux: compile; store 18/18; serviço 9/9; inbox 3/3; protocolo 9/9; migrações 11/11; runner unitário 40/40; integração independente por OPAQUE/TLS pinado/WSS real PASS. Windows: runner oficial em checkout NTFS, compile nativo, suites operacionais e regressões selecionadas PASS, `remote-infrastructure` 20/20, integração WSS independente PASS, fingerprint/HEAD verificados e cleanup PASS. Evidências detalhadas em [G3](evidence/g3-implementation/README.md) e [proposta T2](g3-1-operational-protocol-proposal.md). G3.1–G3.4 concluídas tecnicamente e prontas para auditoria independente; sem declarar G3 auditada ou aprovada para produção. G4 não iniciada.

## Correções dos achados independentes A1–A4 — 2026-11-13

A1–A4 foram corrigidos pelo Luna após a auditoria, sem iniciar G4/H. Handler pós-timeout fica ativo e ocupa capacidade até terminar; drains/close têm prazo e estado `blocked`. Tracks no snapshot reutilizam o validator fechado do pacote. A inbox mantém o cursor como maior prefixo de eventos efetivamente recebido, guarda os watermarks anunciados em campos distintos e migra estado v8 não comprovado para `recovery_required`, preservando o valor legado. Respostas accepted/completed semanticamente idênticas são idempotentes e conflitos terminais continuam rejeitados.

Validação Linux após correções: compile, reproducer A1–A4, store 18/18, protocolo 10/10, serviço/outbox 12/12, inbox 5/5, migrações 12/12, pairing-wire 3/3, remote-infrastructure 20/20 e integração WSS real entre processos PASS. Runner oficial Windows `--operational-store` PASS no checkout NTFS, incluindo compile nativo, suites G3, migração v9, integração operacional, WSS 20/20 e cleanup. Fingerprint Windows `e7db51bc7c000ebd42b0c0f151e4eaf494f03e0efe83740999f96aa505cd1776`.

Reauditoria independente permanece gate; somente a segunda confirma os achados como encerrados para checkpoint. G3 está pronta para reauditoria; checkpoint depende do parecer independente; G4 não iniciada.
