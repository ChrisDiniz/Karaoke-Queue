# 0008/0001 — H1: Gestão Combined preparada para operação remota

## Identificação e estado

- Ticket: 0008/0001
- Etapa canônica: H1; pai 0008 — Integração operacional Gestão + Player.
- Status: Planejado / Não iniciado. Atualização de planejamento em 2026-11-11; sem autorização de implementação nesta rodada.
- [Roadmap](../../standalone-player-roadmap.md), [contrato funcional](../../paired-mode-contract.md), [sequência e matriz de testes](../../paired-mode-execution-plan.md), [interfaces/IDs](../../paired-mode-ui-plan.md).

## Objetivo e limite

Preparar Gestão e persistência para executar remotamente a vez atual sem duplicar fila/writer.

## Pré-requisitos e dependências

G concluída/aprovada; aplicar D1/D4/D5 já aprovadas nos lotes dependentes; autorização H1.

## Módulos envolvidos

src/application.ts; src/main-management-host.ts; src/management-contracts.ts; src/state-repository.ts; types.d.ts; database.ts; src/management-projections.ts. São pontos existentes ou responsabilidades futuras, não alegação de arquivos novos já implementados. Conferir consumidores antes de editar.

## Lotes incrementais

### H1.1

Consultar disponibilidade/metadados no Player durante cadastro; resposta correlacionada, timeout/unknown e código válido sem CSV; manter capacidades administrativas offline. Aplicar D5: conectado bloqueia inexistência comprovada; administrativo offline permite registro marcado não verificado; timeout/unknown não é prova de inexistência; não confundir com aceite de vez, que sempre exige ambas disponíveis.

### H1.2

Projetar persistência aditiva de ocorrências/resultados e origem manual/remota/local; aplicar D1 resolvida: preservar resultado individual de cada música e a semântica atual de rodadas/rotação, sem alteração da lógica Round Robin por vez mista. Preservar legados sem inferência.

### H1.3

Separar atualização administrativa, resultado por música, terminal da vez e promoção; aplicar D4 resolvida: promover automaticamente pelo Round Robin após EOF natural ou Avançar confirmado da última música. Integrar promoção+intenção de envio sem publish anterior ao commit; Stop All nunca promove.

## Critérios de aceite

Fila futura só existe na Gestão; sessão/cantor/mesa e pins/frozen/cadência intactos. Consulta não reserva mídia. Edição administrativa não interrompe playback. Marcação manual offline explícita não fabrica EOF nem duplica evento do Player.

Cada lote entrega diff revisado, testes por impacto e documentação/evidências. Persistência exige preparar → gravar → publicar; sem enfraquecer invariantes ou assertions. Registrar NOT RUN e motivo; PASS técnico não presume aprovação do proprietário.

## Testes obrigatórios

Resposta de consulta velha, MP4 sem CSV, mídia removida após cadastro, alteração de fila futura, sessão antiga, dados legados, rollback e crash entre promoção/intenção. Regressões de Round Robin/2:1/pins/frozen/isolamento de sessão com SQLite real.

Usar relógios/barreiras determinísticos, rede sintética controlada, perfis/bancos isolados e runner Windows oficial quando aplicável. Nenhum sleep arbitrário como sincronização. CI existente recebe somente cenários determinísticos; campanhas físicas/duas máquinas ficam explícitas.

## Interfaces relacionadas

Base 5booCMOuTE, menus oNE_AaxQym/6yW_kHriT1, erro 9VZvnRMUbQ; H4 integra telas.

## Riscos e decisões pendentes

D1/D4/D5 são regras aprovadas a verificar em regressão, não gates funcionais abertos; completeAndAdvance/cancelAndAdvance e editEntry atuais não podem ser usados sem adaptação. D1/D3/D4/D5 resolvidas; D2 parcialmente resolvida (somente descarte definitivo versus retorno da fila suspensa pendente). T1/T2 preservados no contrato; não recriar decisões já aprovadas de autoridade/EOF/pacote.

## Autonomia e conclusão

Implementação apenas com autorização específica do proprietário. Uma autorização de fase não autoriza a próxima. Dentro do lote autorizado, tarefas mecânicas e testes podem ser delegados consecutivamente com ownership exclusivo; parar no gate de decisão técnica/funcional/visual indicado, sem inventar política. Nenhuma etapa foi iniciada por este planejamento.

## Histórico preservado

O ticket anterior era exclusivamente planejado, sem implementação ou validação. A revisão atual detalha esse escopo mantendo ID e posição canônica. A antiga decisão aberta de autoridade em G4 foi resolvida funcionalmente pelo proprietário no contrato pareado; D1–D5 foram posteriormente revisadas pelo proprietário: D1/D3/D4/D5 resolvidas e D2 parcialmente resolvida, conforme o contrato vigente. Não há resultados de testes novos nesta atualização documental.

## Aceite adicional — decisões funcionais aprovadas

Aplicar os cenários DEC-01–05 da [matriz](../../paired-mode-execution-plan.md) conforme o impacto deste ticket: resultados mistos não alteram rodadas/rotação; takeover suspende a fila local, sem importação ou execução automática; vez ativa impede offline até conclusão ou Stop All explicitamente confirmado; EOF/Avançar da última promovem automaticamente uma vez, Stop All não promove; cadastro inexistente comprovado é bloqueado conectado, e offline aceita registro não verificado com revalidação antes do playback. D1/D3/D4/D5 resolvidas, D2 parcialmente resolvida. Preservar a pendência final de descarte versus retorno da fila suspensa. Testes apenas planejados, sem execução nesta atualização.
