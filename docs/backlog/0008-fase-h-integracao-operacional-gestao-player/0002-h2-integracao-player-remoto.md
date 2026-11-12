# 0008/0002 — H2: Integração com Player remoto

## Identificação e estado

- Ticket: 0008/0002
- Etapa canônica: H2; pai 0008 — Integração operacional Gestão + Player.
- Status: Planejado / Não iniciado. Atualização de planejamento em 2026-11-11; sem autorização de implementação nesta rodada.
- [Roadmap](../../standalone-player-roadmap.md), [contrato funcional](../../paired-mode-contract.md), [sequência e matriz de testes](../../paired-mode-execution-plan.md), [interfaces/IDs](../../paired-mode-ui-plan.md).

## Objetivo e limite

Executar uma vez aceita de 1–2 músicas no Player com comandos locais/remotos correlacionados.

## Pré-requisitos e dependências

H1 e G aprovadas; contratos §3–§6; frames H4 consultados/aprovados quando houver UI; autorização H2.

## Módulos envolvidos

src/main-media-runtime.ts; src/standalone-player-{sequence,runtime,contracts}.ts como referência; src/player-playback-service.ts; futuros paired runtime/adapter Main; journal port G3. São pontos existentes ou responsabilidades futuras, não alegação de arquivos novos já implementados. Conferir consumidores antes de editar.

## Lotes incrementais

### H2.1

Implementar aceite único do pacote da vez e validação física de ambas as músicas; rejeição não inicia nem promove ninguém.

### H2.2

Orquestrar apresentação única 5 s, loading, primeira/segunda, transição sem celebração intermediária e celebração final 5 s só para EOF da última. Queda após aceite preserva vez.

### H2.3

Unificar Main arbiter para pause/resume, restart, next e Stop All local; Gestão não oferece Stop/Voltar. Validar token de confirmação e alvo/tentativa; sem submit-code pareado.

### H2.4

Trocar somente música atual após validação/contenção, nova tentativa na mesma ocorrência; paused e erro loading confirmado cobertos; não editar cantada.

### H2.5

Registrar eventos/terminais duráveis antes de publicar; falha em música 2 preserva EOF da 1; restart inesperado sem autoplay.

## Critérios de aceite

Nenhuma ativação/timer/playback duplicado. Apresentação bloqueia ações/edição. Música 2 revalidada antes de executar. Só EOF confirmado vira cantada; Stop All encerra sem avançar fila Gestão. Standalone independente preservado.

Cada lote entrega diff revisado, testes por impacto e documentação/evidências. Persistência exige preparar → gravar → publicar; sem enfraquecer invariantes ou assertions. Registrar NOT RUN e motivo; PASS técnico não presume aprovação do proprietário.

## Testes obrigatórios

Turno duplicado com mesmo/diferente operationId, segunda indisponível, falha entre músicas, queda durante apresentação, reconnect na celebração, EOF×Avançar, local×remoto, troca×EOF, confirmação tardia, Stop All depois de EOF1. Unitários com relógio controlado, Main/IPC e Electron MP4 isolado Linux/Windows.

Usar relógios/barreiras determinísticos, rede sintética controlada, perfis/bancos isolados e runner Windows oficial quando aplicável. Nenhum sleep arbitrário como sincronização. CI existente recebe somente cenários determinísticos; campanhas físicas/duas máquinas ficam explícitas.

## Interfaces relacionadas

3a9l_r00eg; modais locais RVRxz-s16i/2NjukUsCvh/ybFFiZIeQq/GxtqFzuqvy; H4 monta camada visual.

## Riscos e decisões pendentes

Dois orquestradores no mesmo engine; evento terminal ou tentativa obsoleta afetar próxima música; disco cheio após efeito físico. D1/D3/D4/D5 resolvidas; D2 parcialmente resolvida (somente descarte definitivo versus retorno da fila suspensa pendente). T1/T2 preservados no contrato; não recriar decisões já aprovadas de autoridade/EOF/pacote.

## Autonomia e conclusão

Implementação apenas com autorização específica do proprietário. Uma autorização de fase não autoriza a próxima. Dentro do lote autorizado, tarefas mecânicas e testes podem ser delegados consecutivamente com ownership exclusivo; parar no gate de decisão técnica/funcional/visual indicado, sem inventar política. Nenhuma etapa foi iniciada por este planejamento.

## Histórico preservado

O ticket anterior era exclusivamente planejado, sem implementação ou validação. A revisão atual detalha esse escopo mantendo ID e posição canônica. A antiga decisão aberta de autoridade em G4 foi resolvida funcionalmente pelo proprietário no contrato pareado; D1–D5 foram posteriormente revisadas pelo proprietário: D1/D3/D4/D5 resolvidas e D2 parcialmente resolvida, conforme o contrato vigente. Não há resultados de testes novos nesta atualização documental.

## Aceite adicional — decisões funcionais aprovadas

Aplicar os cenários DEC-01–05 da [matriz](../../paired-mode-execution-plan.md) conforme o impacto deste ticket: resultados mistos não alteram rodadas/rotação; takeover suspende a fila local, sem importação ou execução automática; vez ativa impede offline até conclusão ou Stop All explicitamente confirmado; EOF/Avançar da última promovem automaticamente uma vez, Stop All não promove; cadastro inexistente comprovado é bloqueado conectado, e offline aceita registro não verificado com revalidação antes do playback. D1/D3/D4/D5 resolvidas, D2 parcialmente resolvida. Preservar a pendência final de descarte versus retorno da fila suspensa. Testes apenas planejados, sem execução nesta atualização.
