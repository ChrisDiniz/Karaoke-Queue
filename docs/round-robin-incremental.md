# P1 — Round Robin incremental na fila operacional

> Registro da entrega original do Round Robin. O reset de fase então deixado
> para uma etapa seguinte foi corrigido posteriormente em
> [Reset da cadência 2:1](cadence-reset.md). As referências abaixo à fase final 2
> e à Prioridade 2 pendente descrevem a baseline histórica desta entrega.

## Causa e limite da correção

`fairOrder()` distribuía solicitações entre mesas, mas o controlador deixou de
aplicá-la na execução normal ao adotar `queue_order`. Apenas impedir vizinhos
iguais não corrigiria sequências como M1, M2, M1, M2, M3.

A correção opera na sequência existente; não volta a executar `fairOrder()` a
cada consulta. `getPlayOrder()` continua apenas compondo a ordem persistida com
as proteções. Não houve alteração de interface, schema SQLite, IPC, histórico,
ciclo de vida de sessões ou no reset de fase 2:1 identificado como Prioridade 2.

## Política e definição de rodada

`src/round-robin-rules.ts` implementa uma função pura. Percorre a sequência
efetiva e contabiliza **oportunidades projetadas**, uma por turno, por mesa.
Uma rodada corresponde a oferecer uma oportunidade às mesas elegíveis antes
de uma segunda oportunidade, dentro da região que a automação pode modificar.
Não existe uma rodada por cantor, música ou intervalo do relógio.

Para cada posição automática:

1. Preserva a entrada se não houver desigualdade/repetição que possa corrigir.
2. Considera apenas o primeiro pedido restante de cada mesa.
3. Entre alternativas legais, prefere outra mesa à da apresentação anterior;
   depois, a mesa com menos oportunidades projetadas. Empates usam a ordem atual.
4. Insere a alternativa através dos slots automáticos; mantém os demais pedidos
   em ordem relativa, sem trocar posições protegidas.
5. Se um deslocamento liberar outro conflito junto a um pin, completa o reparo
   no mesmo evento até chegar a uma ordem estável. Consultar ou renderizar não
   executa esse processo.

A Vez atual delimita o início do ciclo. Na sua ausência, considera-se a última
conclusão da sessão. A conclusão anterior só conta como oportunidade da rodada
projetada se algum pedido pendente já existia quando ela ocorreu; uma mesa não
recebe crédito retroativo por rodadas anteriores à sua elegibilidade. A mesa
anterior continua sendo considerada para evitar repetição imediata.

O avanço é representado pelo consumo da cabeça da **ordem persistida**, não por
um novo contador de rodadas. O restante da sequência carrega a continuidade do
ciclo. Mesas esgotadas saem da disputa. Uma mesa que volta a pedir entra nas
oportunidades futuras, sem acumular crédito ou penalidade pelas rodadas ausentes.
Novos pedidos regulares são inicialmente acrescentados pelo fluxo existente e
só ultrapassam pedidos quando há um desequilíbrio/repetição corrigível.

## Estreias e decisões manuais

Precedência: **Vez atual → congelamento → pins → automação**.

- Slots efetivos dos pins e IDs congelados nunca são movidos pelo reparo.
- Também não se desloca um pedido automático através de um sucessor protegido
  da mesma mesa se isso inverter a ordem desses pedidos.
- `debutTurnIds()` permanece a fonte da única estreia de cada mesa, considerando
  o histórico concluído de toda a sessão. Não há novos tokens nem reclassificação.
- Uma estreia já na posição visitada é preservada. Ela é uma barreira: uma
  regular posterior não pode atravessá-la para preencher uma vaga 2:1.
- A primeira estreia disponível pode ser antecipada para evitar repetição da
  mesa anterior ou distribuir pedidos adicionais de uma mesa cuja estreia ainda
  está reservada. Não ultrapassa outra estreia.
- A contagem zero de uma mesa estreante não é usada para dar prioridade absoluta
  sobre regulares que já tiveram oportunidades. Conservam-se as vagas 2:1 existentes.
- Movimentação manual e congelamento preservam a sequência escolhida. O reparo
  não é chamado imediatamente pelo drag-and-drop, evitando desfazer a prévia.
- `regularsSinceDebut` continua sendo atualizado somente pelo caminho existente
  de conclusão, com a distinção existente entre turnos automáticos e protegidos.

Quando as barreiras de estreia, ordem interna da mesa ou reservas impedem uma
antecipação, pode permanecer uma repetição. A automação não sacrifica essas
regras para melhorar uma métrica de justiça.

## Integração e recuperação

`KaraokeApplication.repairTableRotation()` aplica o reparo após cadastro,
alteração de mesa, conclusão, cancelamento, liberação de pin, liberação do
congelamento e promoção manual para a Vez atual; também antes de selecionar uma
Vez atual ausente. Editar somente nome/músicas não reorganiza a fila.

Somente a subsequência automática é copiada para a base persistida; locais-base
dos IDs protegidos e seus metadados permanecem intactos. A composição existente
de `fixed-turn-rules` e `frozen-queue-rules` continua soberana.

O campo **já existente** `queueOrderPolicyVersion` passa de 1 para 2. Na primeira
abertura de uma fila v1, aplica-se um único reparo e grava-se a versão 2 pelo
repositório existente. Em reaberturas v2, preserva-se exatamente a ordem salva,
inclusive decisões manuais, sem novo reparo durante o carregamento.

Não há migração estrutural nem campos adicionais. `queue_order`, Vez atual,
histórico, pins, congelamento e fase 2:1 já fornecem a continuidade necessária
para este modelo de rodadas móveis. Não se promete reconstruir retrospectivamente
uma lista histórica de participantes de cada rodada; isso exigiria outro modelo.

## Exemplos verificados

| Situação | Antes | Depois |
|---|---|---|
| Repetição simples | M1-A, M1-B, M2-A | M1-A, M2-A, M1-B |
| Desequilíbrio sem vizinhos iguais | M1, M2, M1, M2, M3 | M1, M2, M3, M1, M2 |
| Pedidos 5/3/2 | M1×5, M2×3, M3×2 | M1,M2,M3 / M1,M2,M3 / M1,M2 / M1 / M1 |
| Chegada de Duda | Yas, Opa, Cristian + Duda | Yas, Opa, Cristian, Duda |
| Prefixo congelado M1/M1 | M1 congelada, M1 congelada, M2 | Prefixo inalterado |
| Uma única mesa | M1×5 | M1×5, sem bloqueio |

## Simulações determinísticas antes/depois

O mesmo roteiro de eventos foi executado contra uma cópia do build anterior
à alteração e contra o novo controlador. `tests/round-robin-simulation.ts`
controla relógio e geração de IDs, executa consultas repetidas, verifica todos
os IDs e reabre o controlador no meio da operação.

### Coorte regular: 40 pedidos de cada uma de três mesas; 100 conclusões

| Métrica | Antes | Depois |
|---|---:|---:|
| Conclusões M1/M2/M3 | 40/40/20 | 34/33/33 |
| Primeira conclusão de cada mesa | 1ª/41ª/81ª | 1ª/2ª/3ª |
| Repetições com alternativa automática | 78 | 0 |
| Maior sequência da mesma mesa | 40 | 1 |
| Maior diferença durante elegibilidade conjunta | 40 | 1 |
| Pendências finais | 20 | 20 |
| Inversões de pares após o reparo inicial | 0 | 0 |

A normalização inicial da fila antiga agrupada corrige 2.340 inversões de pares;
isso não representa 2.340 movimentações do operador. Depois disso, o avanço
normal não exigiu novas inversões. As vinte pendências restantes no novo modelo
estão distribuídas pelas três mesas; não há uma mesa esquecida até a 81ª execução.

### Operação mista: 120 eventos

24 pedidos iniciais; 40 cadastros, 40 conclusões, 10 cancelamentos e operações
de fixação, congelamento/liberação, além de uma recuperação intermediária.
O relógio avança três minutos por evento, atravessando a janela de 90 minutos.

| Métrica | Antes | Depois |
|---|---:|---:|
| Conclusões regulares/estreias, incluindo protegidas | 30/10 | 30/10 |
| Conclusões M1/M2/M3 | 14/8/8 | 10/12/8 |
| Repetições com alternativa automática | 12 | 0 |
| Repetições decorrentes de turno protegido | 5 | 0 |
| Maior sequência da mesma mesa | 5 | 1 |
| Maior diferença durante elegibilidade conjunta | 8 | 2 |
| Pedidos iniciais ainda pendentes | 0 | 0 |
| Pendências finais | 14 | 14 |
| Maior espera observada, em conclusões | 34 | 35 |
| Inversões de pares, todos os eventos | 350 | 436 |

O reparo novo realizou 122 inversões de pares nos eventos, além de 84 na
normalização inicial. O total inclui também alterações do operador e da política
de estreia; a diferença 436−350 não é uma medida isolada do reparo. Os roteiros
manuais selecionam posições, de modo que a mudança na ordem também muda quais
IDs o operador desse roteiro protege.

A sequência automática R/D foi idêntica antes/depois:
`RRRRDRRRRRDRRRRRDRRRRRDRRRRRDR`; a fase final permaneceu 0. Não se afirma que
todo fluxo misto produz uma razão exata 2:1: estabilidade, indisponibilidade dos
grupos e decisões manuais continuam prevalecendo.

## Limites

- A garantia medida de diferença máxima 1 vale para a coorte regular sem
  barreiras. Não se estende incondicionalmente a decisões manuais ou estreias
  cuja oportunidade já está estabelecida.
- Não há garantia matemática de espera finita sob intervenções infinitas do
  operador ou crescimento ilimitado da população elegível. Os cenários finitos
  testados tiveram progresso de todos os pedidos iniciais.
- A maior espera individual na simulação mista aumentou uma conclusão, embora
  a distribuição entre mesas tenha melhorado.
- O bug de reset da fase após a última estreia permanece para a Prioridade 2.
- A política existente de falha de persistência e entradas legadas sem
  `sessionId` não foi alterada.

## Validação

- Baseline: 83 testes/grupos relatados pelo runner, sem falhas.
- Resultado unitário: 93, sem falhas, incluindo casos operacionais, invariantes,
  150 combinações da função pura, 50 composições com pins/congelamento e SQLite.
- E2E focado: Electron real, Xvfb, Playwright e perfil SQLite isolado; cadastro,
  ordem 5/3/2, conclusões, arraste com confirmação, pin, congelamento, chegada,
  liberação, cancelamento e recuperação de IDs diretamente do SQLite.
- Uma sequência estabelecida com seis regulares e três estreias foi executada
  pela UI como `RRDRRDRRD`. O Electron foi reiniciado depois das duas primeiras
  conclusões, recuperando a fase 2 e a estreia já selecionada. Após a última
  estreia, a fase continua 2: confirmação de que a Prioridade 2 não foi corrigida.
- E2E existentes de cadência/caso Duda, sessões anteriores e fechamento de
  sessões passaram.
- E2E completo interrompido em `tests/electron-smoke.ts:636`: timeout esperando
  `#manual-move-modal` após a sequência sintética de arraste, cancelamento e
  Escape. As etapas posteriores desse script não foram executadas. O código de
  drag-and-drop não foi modificado; o fluxo focado de arraste/confirmar passou.

Comandos: `npm run test:unit`, `npm run test:e2e:round-robin:headless`,
`npm run test:e2e:cadence:headless`, `npm run test:e2e:sessions:headless`,
`npm run test:e2e:session-close:headless` e `npm run test:e2e:headless`.

Capturas do teste focado em 1280×800:
- `/tmp/karaoke-rr-evidence-01dUgE/round-robin.png`
- `/tmp/karaoke-rr-evidence-01dUgE/round-robin-protecoes.png`

Resultados completos da comparação: `/tmp/karaoke-p1-round-robin-results.json`.
Logs desta execução: `/tmp/karaoke-p1-unit.log`,
`/tmp/karaoke-p1-round-robin-e2e.log`, `/tmp/karaoke-p1-cadence-e2e.log`,
`/tmp/karaoke-p1-sessions-e2e.log`, `/tmp/karaoke-p1-close-e2e.log` e
`/tmp/karaoke-p1-full-e2e.log`. Arquivos em `/tmp` são evidências temporárias.

## Arquivos desta alteração

- `src/round-robin-rules.ts`: política pura de reparo incremental.
- `src/application.ts`: integração nos eventos e versão da ordem operacional.
- `scripts/copy-assets.ts`: inclusão do novo módulo no bundle existente.
- `package.json`: novos testes no comando unitário e runner Electron focado.
- `tests/round-robin-rules.test.ts`: invariantes da função pura.
- `tests/round-robin-application.test.ts`: execução, proteções e SQLite.
- `tests/round-robin-simulation.ts`: roteiro determinístico e métricas.
- `tests/round-robin-electron.ts`: fluxos reais de UI/IPC/SQLite e reinícios.
- `tests/application.test.ts` e `tests/debut-cadence-electron.ts`: expectativa
  da versão de política atualizada para 2; assertions de ordem preservadas.
- `docs/round-robin-incremental.md`: decisões, resultados e limites.
