# 0007/0001 — G1: Infraestrutura HTTPS/WSS

## Identificação e estado

- Ticket: 0007/0001
- Etapa canônica: G1; pai 0007 — Comunicação remota segura.
- Status: Planejado / Não iniciado. Atualização de planejamento em 2026-11-11; sem autorização de implementação nesta rodada.
- [Roadmap](../../standalone-player-roadmap.md), [contrato funcional](../../paired-mode-contract.md), [sequência e matriz de testes](../../paired-mode-execution-plan.md), [interfaces/IDs](../../paired-mode-ui-plan.md).

## Objetivo e limite

Estabelecer transporte seguro e identidade sem acoplar rede ao domínio operacional.

## Pré-requisitos e dependências

F encerrada; autorização G1.1. T1 aprovada antes de G1.2.

## Módulos envolvidos

main.ts; src/main-ipc-policy.ts; futuros ports e adapter HTTPS/WSS Main-only. São pontos existentes ou responsabilidades futuras, não alegação de arquivos novos já implementados. Conferir consumidores antes de editar.

## Lotes incrementais

### G1.1

Propor confiança TLS, provisionamento, rotação/revogação e armazenamento de segredos; definir descoberta/endereço, limites, versões e threat model. Entregar decisão técnica revisável, sem abrir portas.

### G1.2

Após aprovação técnica, implementar identidade estável e transporte limitado; negociar versão/capacidades; autenticar handshake; limites de payload, timeout e encerramento.

### G1.3

Validar segurança, IPC/origem, redaction e ciclo de vida; nenhuma credencial ou mídia concedida ao Renderer remoto.

## Critérios de aceite

Versão desconhecida, peer não confiável, payload inválido e excesso de limite não executam ação; shutdown fecha recursos; segredos não aparecem em logs/respostas.

Cada lote entrega diff revisado, testes por impacto e documentação/evidências. Persistência exige preparar → gravar → publicar; sem enfraquecer invariantes ou assertions. Registrar NOT RUN e motivo; PASS técnico não presume aprovação do proprietário.

## Testes obrigatórios

TLS inválido/expirado, identidade adulterada, versão incompatível, conexão interrompida no handshake, limites, vazamento de segredo e cleanup. Unitários e integração de transporte Linux/Windows.

Usar relógios/barreiras determinísticos, rede sintética controlada, perfis/bancos isolados e runner Windows oficial quando aplicável. Nenhum sleep arbitrário como sincronização. CI existente recebe somente cenários determinísticos; campanhas físicas/duas máquinas ficam explícitas.

## Interfaces relacionadas

Sem tela nova de operação; experiência de confiança G2 depende da proposta T1.

## Riscos e decisões pendentes

T1 exige revisão antes de exposição; políticas Windows/firewall não podem ser alteradas silenciosamente. D1/D3/D4/D5 resolvidas; D2 parcialmente resolvida (somente descarte definitivo versus retorno da fila suspensa pendente). T1/T2 preservados no contrato; não recriar decisões já aprovadas de autoridade/EOF/pacote.

## Autonomia e conclusão

Implementação apenas com autorização específica do proprietário. Uma autorização de fase não autoriza a próxima. Dentro do lote autorizado, tarefas mecânicas e testes podem ser delegados consecutivamente com ownership exclusivo; parar no gate de decisão técnica/funcional/visual indicado, sem inventar política. Nenhuma etapa foi iniciada por este planejamento.

## Histórico preservado

O ticket anterior era exclusivamente planejado, sem implementação ou validação. A revisão atual detalha esse escopo mantendo ID e posição canônica. A antiga decisão aberta de autoridade em G4 foi resolvida funcionalmente pelo proprietário no contrato pareado; D1–D5 foram posteriormente revisadas pelo proprietário: D1/D3/D4/D5 resolvidas e D2 parcialmente resolvida, conforme o contrato vigente. Não há resultados de testes novos nesta atualização documental.
