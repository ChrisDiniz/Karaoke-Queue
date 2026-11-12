# 0007/0005 — G5: Interface dos estados de conexão

## Identificação e estado

- Ticket: 0007/0005
- Etapa canônica: G5; pai 0007 — Comunicação remota segura.
- Status: Planejado / Não iniciado. Atualização de planejamento em 2026-11-11; sem autorização de implementação nesta rodada.
- [Roadmap](../../standalone-player-roadmap.md), [contrato funcional](../../paired-mode-contract.md), [sequência e matriz de testes](../../paired-mode-execution-plan.md), [interfaces/IDs](../../paired-mode-ui-plan.md).

## Objetivo e limite

Integrar estados reais de conexão e de operações de protocolo às referências visuais.

## Pré-requisitos e dependências

G1–G4; frames atuais consultados novamente e aprovados para implementação; autorização G5.

## Módulos envolvidos

src/standalone-player-renderer.ts; HTML/CSS Player; src/ui; Preloads e IPC específicos. São pontos existentes ou responsabilidades futuras, não alegação de arquivos novos já implementados. Conferir consumidores antes de editar.

## Lotes incrementais

### G5.1

Mapear conexão real conectada/reconectando/desconectada/erro para os dez frames Player existentes; separar link de controle reconciliado.

### G5.2

Exibir não enviado, rejeitado e resultado incerto sem spinner infinito; consulta usa operationId original, nunca reenvio cego.

### G5.3

Preservar playback e foco; comparar screenshots Electron/Doop nas dimensões de referência e obter revisão humana.

## Critérios de aceite

UI não simula conexão, não toma controle por toast e não habilita código local por desconexão. Falha antes do envio distingue-se de comando enviado com resultado desconhecido. Fechar aviso não apaga pendência.

Cada lote entrega diff revisado, testes por impacto e documentação/evidências. Persistência exige preparar → gravar → publicar; sem enfraquecer invariantes ou assertions. Registrar NOT RUN e motivo; PASS técnico não presume aprovação do proprietário.

## Testes obrigatórios

Perda real do socket, erro TLS e timeout de consulta; IPC/origem e acessibilidade teclado; screenshots 1280×800 Player/1440×920 Gestão. Electron real Linux/Windows.

Usar relógios/barreiras determinísticos, rede sintética controlada, perfis/bancos isolados e runner Windows oficial quando aplicável. Nenhum sleep arbitrário como sincronização. CI existente recebe somente cenários determinísticos; campanhas físicas/duas máquinas ficam explícitas.

## Interfaces relacionadas

Reutilizar IDs na matriz de interfaces; novos Y47usa8PN0/kKJpUsOjMV. UI de vez/confirmar/takeover pertence H4.

## Riscos e decisões pendentes

Frames antigos LZhLxxiEgE e toasts de reconexão não autorizam controle automático. D1/D3/D4/D5 resolvidas; D2 parcialmente resolvida (somente descarte definitivo versus retorno da fila suspensa pendente). T1/T2 preservados no contrato; não recriar decisões já aprovadas de autoridade/EOF/pacote.

## Autonomia e conclusão

Implementação apenas com autorização específica do proprietário. Uma autorização de fase não autoriza a próxima. Dentro do lote autorizado, tarefas mecânicas e testes podem ser delegados consecutivamente com ownership exclusivo; parar no gate de decisão técnica/funcional/visual indicado, sem inventar política. Nenhuma etapa foi iniciada por este planejamento.

## Histórico preservado

O ticket anterior era exclusivamente planejado, sem implementação ou validação. A revisão atual detalha esse escopo mantendo ID e posição canônica. A antiga decisão aberta de autoridade em G4 foi resolvida funcionalmente pelo proprietário no contrato pareado; D1–D5 foram posteriormente revisadas pelo proprietário: D1/D3/D4/D5 resolvidas e D2 parcialmente resolvida, conforme o contrato vigente. Não há resultados de testes novos nesta atualização documental.

## Revisão T1 — descoberta/pareamento integral LAN (planejado)

Acrescentar G5.4 — pareamento/renovação guiados: ícone Dispositivos imediatamente à esquerda do sino, lista real mDNS (buscando, vazio, encontrado não verificado, vínculo salvo, conectado confirmado, indisponível), Atualizar e Avançado. Solicitação Player, aceite/rejeição, código SRP 8 dígitos, verificação/persistência, cancelamento/timeout/quota, falha de confiança e renovação 30/7 dias. G5 usa ports G1/G2/G4, sem matemática/autorização no Renderer. Critérios: nunca confiar em TXT, mostrar nome como informado/não verificado, segredo permanente não exposto, código efêmero sem log, conexão/reconciliação/offline distintos. Frames novos ainda não criados; consultar inventário e aguardar autorização visual. G5 permanece dependente G1–G4 para integração final; G2 testa apresentação por port isolado.

Referência técnica: [complemento T1 LAN](../../g1-1-t1-lan-pairing.md), ainda aguardando aprovação. Nenhuma implementação/teste de aplicação, alteração Doop ou início automático autorizado. T2/D2 e decisões funcionais aprovadas preservados.
