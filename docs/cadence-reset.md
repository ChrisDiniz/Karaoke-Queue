# Reset da cadência operacional 2:1

## Causa e correção

Em `KaraokeApplication.markDone()`, o reset e o incremento estavam sujeitos à
mesma condição externa:

```ts
wasAutomatic && (wasDebut ? hasAutomaticRegular : hasAutomaticDebut)
```

Uma estreia automática concluída sem regulares automáticas pendentes deixava
`regularsSinceDebut` intacto. A condição agora é separada:

```ts
if (wasAutomatic && wasDebut) regularsSinceDebut = 0
else if (wasAutomatic && hasAutomaticDebut)
  regularsSinceDebut = Math.min(2, regularsSinceDebut + 1)
```

`wasAutomatic` e `wasDebut` continuam sendo capturados antes de remover o turno
da fila e inserir sua conclusão no histórico. O reset depende da conclusão
real de uma estreia na Vez atual, selecionada automaticamente. Remoções,
cancelamentos, seleção e movimentações não disparam esse reset.

| Operação | Efeito na fase |
|---|---|
| Concluir estreia automática | Zera, independentemente do grupo restante |
| Concluir regular automática com estreia automática aguardando | Incrementa até 2, como antes |
| Concluir regular sem estreia automática disponível | Mantém, como antes |
| Concluir estreia selecionada de congelamento/pin ou promovida manualmente | Mantém |
| Concluir entrada que não é a Vez atual automática | Mantém |
| Cancelar estreia, inclusive a Vez atual | Mantém; transferência do token preservada |
| Selecionar, arrastar, fixar ou liberar | Não consome oportunidade |

## Reprodução

Execução: `R → R → E → R → R → E → R → R → E`.

| Resultado | Antes | Depois |
|---|---|---|
| Fase após a última estreia, sem regulares | 2 | 0 |
| Cadastro posterior de R1, R2, E1 antes da seleção | E1 → R1 → R2 | R1 → R2 → E1 |
| Versão da ordem operacional | 2 | 2 |

A reprodução antes/depois foi executada contra uma cópia do build original e
o controlador corrigido. Os novos testes falharam com o código antigo em quatro
grupos, incluindo o contador 2 em vez de 0 e fases antigas na simulação longa.

## Preservação do Round Robin e persistência

A única função de produção alterada é `markDone()`, em `src/application.ts`.
O reparo Round Robin continua no mesmo ponto e recebe o mesmo estado da fila;
nenhuma chamada adicional a ordenadores ou persistência foi introduzida.

Arquivos `round-robin-rules.ts`, `queue-rules.ts`, `debut-cadence-rules.ts`,
`fixed-turn-rules.ts`, `frozen-queue-rules.ts`, `state-repository.ts` e `database.ts`
permaneceram idênticos, verificados por SHA-256. A versão da política permanece 2.

O snapshot já existente da conclusão inclui o histórico atualizado e a fase
zerada. SQLite utiliza os campos existentes; não houve migração, alteração de
IPC ou mudança no tratamento de falhas de gravação.

Não é feito saneamento retroativo de fases antigas durante o carregamento:
a correção atua nas novas conclusões automáticas. Inferir a origem de conclusões
passadas para modificar silenciosamente sessões existentes está fora do escopo.

## Simulações

`tests/cadence-reset-simulation.ts` executa oito ciclos com relógio e IDs
controlados: cadastros regulares/estreias, drenagem, retomada, somente estreias,
somente regulares, cancelamento com transferência de token e conclusão protegida.

| Métrica em 128 eventos | Antes | Depois |
|---|---:|---:|
| Conclusões | 48 | 48 |
| Cancelamentos | 8 | 8 |
| Recuperações do estado | 8 | 8 |
| Conclusões protegidas | 8 | 8 |
| Estreias automáticas concluídas com fase indevidamente retida | 8 | 0 |
| Fase ao final dos oito ciclos principais | 2,0,2,0,2,0,2,0 | 0,0,0,0,0,0,0,0 |
| Novas entradas ultrapassando pedidos existentes | 8 | 0 |
| Inversões entre pedidos já existentes | 0 | 0 |
| Repetições consecutivas evitáveis | 0 | 0 |
| Conclusões das mesas regulares 1/2/3 | 8/8/8 | 8/8/8 |

O bloco de seis conclusões por ciclo era alternadamente `RREERE` e `ERRERE`;
passou a ser sempre `RREERE`. Os grupos únicos refletem o roteiro: uma estreia
isolada continua sendo atendida sem esperar vagas regulares inexistentes, e o
último E de cada bloco é protegido, sem modificar a fase.

Também foram repetidas, antes/depois, as simulações do Round Robin: 100
conclusões regulares continuam distribuídas em 34/33/33, com zero repetições
evitáveis; os 120 eventos mistos mantêm distribuição, sequência automática e
fase final. A regressão Duda mantém Yas → Opa → Cristian → Duda.

Resultados completos: `/tmp/karaoke-cadence-reset-comparison.json`.

## Validação final

- Baseline: 93 testes/grupos aprovados. Após a correção: 99 aprovados.
- Testes de cancelamento abrangem tanto a estreia pendente quanto a estreia
  já selecionada automaticamente como Vez atual.
- E2E focado aprovado com Electron real, Playwright headless, Xvfb e SQLite via
  IPC em perfil temporário isolado. A sequência `RRERRERRE` foi concluída pela
  interface, verificando fase 0 e status `done` diretamente no banco.
- O teste aciona o fechamento normal e fornece a resposta “Sair sem encerrar
  sessão” ao diálogo nativo. Confirma `ended_at = NULL`, reabre o Electron,
  continua a mesma sessão e verifica fase 0. Novos cadastros ficam R1 (atual),
  R2 e E1, sem avanço da cadência por simples seleção.
- No mesmo runner passaram: Round Robin 5/3/2, drag-and-drop/confirmar, pin,
  congelamento, liberação, cancelamento e reinícios com proteções persistidas.
- O E2E existente de cadência/Duda passou.
- O E2E completo parou no timeout conhecido de `#manual-move-modal`, em
  `tests/electron-smoke.ts:636`. Suas etapas posteriores não foram executadas.
  A implementação de drag-and-drop não foi alterada.
- A primeira tentativa do runner focado observou divergência ao clicar no
  seletor genérico de conclusão. O teste foi vinculado ao ID capturado do turno
  e passou a verificar uma única conclusão por clique no SQLite; a execução
  isolada completa passou. Não foi feita alteração de produção para esse evento.

Comandos: `npm run test:unit` e, com o build pronto,
`env -u WAYLAND_DISPLAY xvfb-run -a node build/tests/round-robin-electron.js`,
`env -u WAYLAND_DISPLAY xvfb-run -a node build/tests/debut-cadence-electron.js` e
`env -u WAYLAND_DISPLAY xvfb-run -a node build/tests/electron-smoke.js`.

Logs temporários: `/tmp/karaoke-cadence-reset-unit.log`,
`/tmp/karaoke-cadence-reset-electron.log`, `/tmp/karaoke-cadence-reset-duda.log`
e `/tmp/karaoke-cadence-reset-full.log`. Capturas do runner focado:
`/tmp/karaoke-rr-evidence-sFxo4b/`.

## Arquivos desta alteração

- `src/application.ts`: separação das condições de reset e incremento.
- `tests/application.test.ts`: seis grupos novos e correção da expectativa antiga
  que validava a fase 1 após a última estreia; nenhum teste foi removido.
- `tests/cadence-reset-simulation.ts`: roteiro determinístico de 128 eventos.
- `tests/round-robin-electron.ts`: verificação da fase zerada, fechamento normal
  sem encerrar sessão, recuperação e novos cadastros; cliques de conclusão
  vinculados ao ID do turno e verificação de uma única conclusão por clique.
- Este relatório e nota histórica em `docs/round-robin-incremental.md`.
