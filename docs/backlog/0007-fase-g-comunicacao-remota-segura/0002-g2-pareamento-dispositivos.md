# 0007/0002 — G2: Pareamento de dispositivos

## Identificação e estado

- Ticket: 0007/0002
- Etapa canônica: G2; pai 0007 — Comunicação remota segura.
- Status: Planejado / Não iniciado. Atualização de planejamento em 2026-11-11; sem autorização de implementação nesta rodada.
- [Roadmap](../../standalone-player-roadmap.md), [contrato funcional](../../paired-mode-contract.md), [sequência e matriz de testes](../../paired-mode-execution-plan.md), [interfaces/IDs](../../paired-mode-ui-plan.md).

## Objetivo e limite

Autorizar um Controller por Player, com consentimento e revogação verificáveis.

## Pré-requisitos e dependências

G1 aprovada; T1 fechada; contrato de controlEpoch G3.1 descrito no plano, sem depender de integração H.

## Módulos envolvidos

Identidades/adapter G1; futuros pairing store/authorization Main; src/main-ipc-policy.ts. São pontos existentes ou responsabilidades futuras, não alegação de arquivos novos já implementados. Conferir consumidores antes de editar.

## Lotes incrementais

### G2.1

Definir vínculo único, concessão de confiança, escopos e credenciais; autenticação não transfere automaticamente controle operacional.

### G2.2

Implementar consentimento, revogação e fencing de geração de vínculo; recusar Controller concorrente e mensagens do vínculo revogado.

### G2.3

Testar restart, revogação concorrente e recuperação da configuração; documentar o fluxo de confiança e suas interfaces após T1.

## Critérios de aceite

Só peer vinculado pode consultar/controlar capacidades concedidas; revogação impede novos comandos sem fabricar EOF; segundo Controller não assume silenciosamente.

Cada lote entrega diff revisado, testes por impacto e documentação/evidências. Persistência exige preparar → gravar → publicar; sem enfraquecer invariantes ou assertions. Registrar NOT RUN e motivo; PASS técnico não presume aprovação do proprietário.

## Testes obrigatórios

Dispositivo não autorizado, dois Controllers simultâneos, credencial revogada, retry de pairing e restart com vínculo persistido. Integração Main/IPC e dois peers reais em G6.

Usar relógios/barreiras determinísticos, rede sintética controlada, perfis/bancos isolados e runner Windows oficial quando aplicável. Nenhum sleep arbitrário como sincronização. CI existente recebe somente cenários determinísticos; campanhas físicas/duas máquinas ficam explícitas.

## Interfaces relacionadas

Não existem frames de provisionamento T1 entre os 13 originais; desenhar complemento após a estratégia técnica, sem usar takeover como pairing.

## Riscos e decisões pendentes

Confundir consentimento de vínculo com takeover ou com seleção de função instalada. D1/D3/D4/D5 resolvidas; D2 parcialmente resolvida (somente descarte definitivo versus retorno da fila suspensa pendente). T1/T2 preservados no contrato; não recriar decisões já aprovadas de autoridade/EOF/pacote.

## Autonomia e conclusão

Implementação apenas com autorização específica do proprietário. Uma autorização de fase não autoriza a próxima. Dentro do lote autorizado, tarefas mecânicas e testes podem ser delegados consecutivamente com ownership exclusivo; parar no gate de decisão técnica/funcional/visual indicado, sem inventar política. Nenhuma etapa foi iniciada por este planejamento.

## Histórico preservado

O ticket anterior era exclusivamente planejado, sem implementação ou validação. A revisão atual detalha esse escopo mantendo ID e posição canônica. A antiga decisão aberta de autoridade em G4 foi resolvida funcionalmente pelo proprietário no contrato pareado; D1–D5 foram posteriormente revisadas pelo proprietário: D1/D3/D4/D5 resolvidas e D2 parcialmente resolvida, conforme o contrato vigente. Não há resultados de testes novos nesta atualização documental.

## Revisão T1 — descoberta/pareamento integral LAN (planejado)

G2.1: fixar/revisar biblioteca fast-srp-hap, perfil SRP-6a, transcript/binding autenticado do certificado, formato e vetores, com revisão independente antes de produção. Não implementar primitivas próprias. G2.2: consentimento local, código 8 dígitos 120 s/3 tentativas, quota global, sessão única, provas mútuas, persistência de trust/bearer e revogação confirmada. G2.3: MITM/relay de provas com certificado diferente, cancelamento/replay/timeout, duas Gestões, crash de cada commit e recuperação anual sem token antigo em TLS não confiado. Sem arquivos/QR/IP no fluxo normal. Pairing tem port de apresentação testável; G5 integra UI final sem ciclo G2→G5→G4→G2. Nenhuma exposição em produção antes da apresentação local restrita aprovada. G2 continua não iniciada.

Referência técnica: [complemento T1 LAN](../../g1-1-t1-lan-pairing.md), ainda aguardando aprovação. Nenhuma implementação/teste de aplicação, alteração Doop ou início automático autorizado. T2/D2 e decisões funcionais aprovadas preservados.
