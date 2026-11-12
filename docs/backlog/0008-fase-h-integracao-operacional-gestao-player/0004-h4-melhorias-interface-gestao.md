# 0008/0004 — H4: Melhorias da interface de Gestão

## Identificação e estado

- Ticket: 0008/0004
- Etapa canônica: H4; pai 0008 — Integração operacional Gestão + Player.
- Status: Planejado / Não iniciado. Atualização de planejamento em 2026-11-11; sem autorização de implementação nesta rodada.
- [Roadmap](../../standalone-player-roadmap.md), [contrato funcional](../../paired-mode-contract.md), [sequência e matriz de testes](../../paired-mode-execution-plan.md), [interfaces/IDs](../../paired-mode-ui-plan.md).

## Objetivo e limite

Integrar UI Gestão/Player pareados aos contratos operacionais reais, sem reconstruir fila.

## Pré-requisitos e dependências

H2/H3 por lote; G5 pronta; frames draft precisam revisão humana antes de implementar; autorização H4.

## Módulos envolvidos

src/ui; src/standalone-player-renderer.ts; HTML/CSS; Preloads/IPC restritos. São pontos existentes ou responsabilidades futuras, não alegação de arquivos novos já implementados. Conferir consumidores antes de editar.

## Lotes incrementais

### H4.1

Gestão: cadastro/metadados opcionais, cantada/cancelada, edição administrativa e comandos Play/Pause, Recomeçar, Avançar, sem Voltar/Parar.

### H4.2

Integrar confirmação Recomeçar/Avançar primeira/última e troca com token obsoleto; nenhuma janela pausa música. Criar variantes pendentes da matriz antes de implementar.

### H4.3

Player: apresentação de 5 s, idle existente, erro/recuperação e comandos locais confirmados; sem entrada pareada. Espera não tem timeout fixo nem modal automático.

### H4.4

Integrar offline/retorno/takeover/divergência e impedir reassunção por toast; aplicar suspensão D2 e restrição de offline D3 já aprovadas; não oferecer descarte definitivo/retorno automático da fila suspensa sem decisão posterior.

### H4.5

Comparar render Electron com Doop nas dimensões corretas; foco, Tab/Esc/Enter, alvo atualizado e mensagens de erro; aprovação visual humana separada de testes.

## Critérios de aceite

HTML/controles não divergem da autoridade Main; bloqueio em apresentação/loading/transição, exceção de erro loading. Tela não exibe Substituída permanente. Metadados ausentes não bloqueiam código. Frames aprovados originais preservados.

Cada lote entrega diff revisado, testes por impacto e documentação/evidências. Persistência exige preparar → gravar → publicar; sem enfraquecer invariantes ou assertions. Registrar NOT RUN e motivo; PASS técnico não presume aprovação do proprietário.

## Testes obrigatórios

Electron real Linux/Windows, teclado/foco/zoom conforme dimensões suportadas; screenshots 1440×920 Gestão e 1280×800 Player; modal aberto×EOF, erro de consulta, comando incerto e perda de rede; regressões fila e Standalone independente.

Usar relógios/barreiras determinísticos, rede sintética controlada, perfis/bancos isolados e runner Windows oficial quando aplicável. Nenhum sleep arbitrário como sincronização. CI existente recebe somente cenários determinísticos; campanhas físicas/duas máquinas ficam explícitas.

## Interfaces relacionadas

Todos os IDs e estados em paired-mode-ui-plan.md; não duplicar implementação dos avisos de protocolo de G5.

## Riscos e decisões pendentes

Rascunho não é aprovação visual; frames originais têm três conflitos descritos na matriz e não autorizam comportamento antigo. D1/D3/D4/D5 resolvidas; D2 parcialmente resolvida (somente descarte definitivo versus retorno da fila suspensa pendente). T1/T2 preservados no contrato; não recriar decisões já aprovadas de autoridade/EOF/pacote.

## Autonomia e conclusão

Implementação apenas com autorização específica do proprietário. Uma autorização de fase não autoriza a próxima. Dentro do lote autorizado, tarefas mecânicas e testes podem ser delegados consecutivamente com ownership exclusivo; parar no gate de decisão técnica/funcional/visual indicado, sem inventar política. Nenhuma etapa foi iniciada por este planejamento.

## Histórico preservado

O ticket anterior era exclusivamente planejado, sem implementação ou validação. A revisão atual detalha esse escopo mantendo ID e posição canônica. A antiga decisão aberta de autoridade em G4 foi resolvida funcionalmente pelo proprietário no contrato pareado; D1–D5 foram posteriormente revisadas pelo proprietário: D1/D3/D4/D5 resolvidas e D2 parcialmente resolvida, conforme o contrato vigente. Não há resultados de testes novos nesta atualização documental.

## Aceite adicional — decisões funcionais aprovadas

Aplicar os cenários DEC-01–05 da [matriz](../../paired-mode-execution-plan.md) conforme o impacto deste ticket: resultados mistos não alteram rodadas/rotação; takeover suspende a fila local, sem importação ou execução automática; vez ativa impede offline até conclusão ou Stop All explicitamente confirmado; EOF/Avançar da última promovem automaticamente uma vez, Stop All não promove; cadastro inexistente comprovado é bloqueado conectado, e offline aceita registro não verificado com revalidação antes do playback. D1/D3/D4/D5 resolvidas, D2 parcialmente resolvida. Preservar a pendência final de descarte versus retorno da fila suspensa. Testes apenas planejados, sem execução nesta atualização.
