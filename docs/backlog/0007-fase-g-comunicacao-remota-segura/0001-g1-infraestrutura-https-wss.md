# 0007/0001 — G1: Infraestrutura HTTPS/WSS

## Aceite do proprietário — G1 homologada com limitações — 2026-11-12

O proprietário aceitou a G1 e determinou seu encerramento como **homologada com limitações**, após o parecer técnico independente favorável. G1.2 está concluída; G1.3 foi aceita com as limitações abaixo. Esse aceite substitui o estado anterior de “aguardando aceite final”; os resultados técnicos históricos permanecem preservados e a validação integral de todas as plataformas não é declarada.

- Windows nativo: NOT RUN; o runner oficial bloqueou o arquivo-fonte `src/remote-secret-protector.ts` pela heurística de nome sensível antes da sincronização. A execução nativa continua pendente.
- Empacotamento: smoke ASAR focado PASS; rebuild limpo pendente por indisponibilidade externa/DNS (`EAI_AGAIN github.com` na tentativa anterior).
- Multicast real local WSL: PASS; LAN entre computadores e plataformas nativas permanece para G6.
- E2E audiovisual com MP4: NOT RUN, sem fixture aprovada; não bloqueia o aceite da infraestrutura G1.

A G1 está tecnicamente apta para G2 e seu aceite pelo proprietário está registrado. G2 permanece não iniciada e depende de autorização própria. T2, D2 e os demais gates futuros permanecem vigentes. Nenhum resultado NOT RUN foi convertido em PASS. Este checkpoint não encerra a Fase G inteira.

## Identificação e estado

- Ticket: 0007/0001
- Etapa canônica: G1; pai 0007 — Comunicação remota segura.
- Status: T1 aprovada, incluindo revisão do serial X.509 para mínimo de 64 bits de entropia. G1.2-A–D implementadas e **PASS na auditoria final**. G1.3 segue **parcial**: a auditoria final repetiu compilação, TLS/WSS 18/18, cache DNS-SD 7/7, interface privada 1/1, processos independentes 1/1 (27/27 no grupo remoto), multicast local real 1/1, Electron Linux fail-closed e smoke focalizado ASAR PASS. Windows nativo ficou NOT RUN porque o runner bloqueou antes da sincronização um arquivo-fonte pelo nome; rebuild limpo não foi executado por indisponibilidade DNS (`github.com`), e LAN física segue para G6. Parecer independente: tecnicamente apta para iniciar G2, mas não integralmente homologada; essa avaliação não satisfaz o pré-requisito “G1 aprovada” nem autoriza G2. G2–G6 não iniciadas.
- [Roadmap](../../standalone-player-roadmap.md), [contrato funcional](../../paired-mode-contract.md), [sequência e matriz de testes](../../paired-mode-execution-plan.md), [interfaces/IDs](../../paired-mode-ui-plan.md).

## Objetivo e limite

Estabelecer transporte seguro e identidade sem acoplar rede ao domínio operacional.

## Pré-requisitos e dependências

F encerrada; T1 aprovada e G1.2/G1.3 explicitamente autorizadas. O proprietário resolveu o gate do serial: `selfsigned@5.5.0` foi mantido com requisito mínimo de 64 bits de entropia, validação de serial positivo/não zero e fingerprint SHA-256 calculado do DER via `node:crypto`. G1.2 foi implementada; a validação técnica G1.3 permanece parcial conforme as evidências registradas. G2 permanece fora do escopo.

## Módulos envolvidos

`main-runtime.ts` como composition root; `src/main-remote-runtime.ts` coordena lifecycle explícito; `src/remote-contracts.ts`, `remote-secret-protector.ts`, `remote-tls.ts`, `remote-identity-store.ts`, `remote-clients.ts`, `remote-discovery.ts` e `remote-transport.ts` implementam contratos/adapters Main-only. G1 não instala integração operacional, G2 ou endpoints de negócio. Os arquivos adicionais de testes e empacotamento constam na proposta T1.

## Lotes incrementais

### G1.1

Proposta aprovada e executada em infraestrutura: [T1 — confiança e transporte seguro](../../g1-1-t1-secure-transport-proposal.md). HTTPS/WSS Main-only, pin do certificado Player, bearer autorizado via port futuro G2, descoberta mDNS/DNS-SD IPv4 e safeStorage fail-closed. O serial X.509 é positivo/não zero, CSPRNG e mínimo de 64 bits, conforme decisão explícita do proprietário. Sem G2, autorização operacional permanece deny-all; sem rotas registradas não há operação de negócio.

### G1.2

**Concluídas.** A — contratos versionados/ports, identidade persistente e proteção de segredo; B — certificado próprio validado, pin SHA-256 DER e clientes TLS; C — autorização deny-all, handshake mínimo, limites de HTTP/WSS e dispatch serializado; D — composição Main explícita, descoberta DNS-SD e encerramento seguro. Nenhum listener inicia no startup normal; Player anuncia apenas após start explícito, Management descobre quando solicitado. Sem G2, não há autorização operacional nem rotas de negócio.

### G1.3

**Parcial, com G1.2 concluída.** A — há evidência anterior de `npm run test:unit` PASS; nesta auditoria final foram repetidos `npm run compile`, 7 regressões determinísticas do cache DNS-SD, infraestrutura TLS/WSS 18/18, rede privada 1/1 e harness de processos 1/1 (**27/27 PASS** no grupo remoto). O adapter consulta e revalida interfaces a cada 60 segundos; cache isolado por interface, filtragem da origem pela subrede e registros não relacionados que não consomem limites. A primeira descoberta real falhou porque os sockets UDP faziam bind no IP unicast. Com bind multicast wildcard restrito à camada UDP e filtro da origem IPv4 pela subrede selecionada, o teste real local passou; LAN entre máquinas continua sem validação. Também foi corrigida a corrida publisher update/stop. A auditoria final repetiu mDNS real local 1/1, sem defeito novo. B — Electron 45/Linux confirmou fail-closed em `basic_text`; smoke focalizado do módulo atual em ASAR passou, mas a build limpa continua pendente por indisponibilidade DNS (`github.com`). O runner oficial Windows funcionou até inventariar a working tree e bloqueou antes da sincronização o arquivo-fonte `src/remote-secret-protector.ts` pela heurística de caminho sensível; Windows nativo permanece NOT RUN. C — auditoria independente final sem achados bloqueantes: G1 está tecnicamente apta para iniciar G2, mas não homologada integralmente. A recomendação não inicia G2; autorização continua separada.

## Critérios de aceite

Versão desconhecida, peer não confiável, payload inválido e excesso de limite não executam ação; shutdown fecha recursos; segredos não aparecem em logs/respostas.

Cada lote entrega diff revisado, testes por impacto e documentação/evidências. Persistência exige preparar → gravar → publicar; sem enfraquecer invariantes ou assertions. Registrar NOT RUN e motivo; PASS técnico não presume aprovação do proprietário.

## Testes obrigatórios

TLS inválido/expirado, identidade adulterada, versão incompatível, conexão interrompida no handshake, limites, vazamento de segredo e cleanup. Unitários e integração de transporte Linux/Windows.

Usar relógios/barreiras determinísticos, rede sintética controlada, perfis/bancos isolados e runner Windows oficial quando aplicável. Nenhum sleep arbitrário como sincronização. CI existente recebe somente cenários determinísticos; campanhas físicas/duas máquinas ficam explícitas.

## Interfaces relacionadas

Sem tela nova de operação; experiência de confiança G2 depende da proposta T1.

## Riscos e decisões pendentes

G1 não abre listener no startup normal e não altera firewall. O multicast local em WSL passou, mas a descoberta entre máquinas em LAN física e Windows nativo permanecem sem validação; o smoke focado do módulo corrigido em ASAR passou, enquanto o rebuild limpo permanece pendente por indisponibilidade DNS para `github.com`. A execução nativa Windows foi bloqueada antes da sincronização por uma regra do runner que classificou o arquivo-fonte `src/remote-secret-protector.ts` como sensível; não houve transferência nem contorno da proteção. Testes locais não provam compatibilidade em outra plataforma ou duas máquinas. D1/D3/D4/D5 resolvidas; D2 parcialmente resolvida (somente descarte definitivo versus retorno da fila suspensa pendente). T2 permanece gate de G3; não recriar decisões aprovadas de autoridade/EOF/pacote.

## Autonomia e conclusão

O proprietário autorizou G1.2/G1.3 integralmente e aprovou depois a revisão pontual do serial, sem autorizar G2. G1.2-A–D foram implementadas; G1.3 executada com evidência parcial. A tabela detalhada de comandos, resultados e NOT RUN está em [T1](../../g1-1-t1-secure-transport-proposal.md). Não houve alteração de firewall, Doop, playback, queue ou persistência operacional, nem commit/push.

## Histórico preservado

O ticket anterior era exclusivamente planejado, sem implementação ou validação. A revisão atual detalha esse escopo mantendo ID e posição canônica. A antiga decisão aberta de autoridade em G4 foi resolvida funcionalmente pelo proprietário no contrato pareado; D1–D5 foram posteriormente revisadas pelo proprietário: D1/D3/D4/D5 resolvidas e D2 parcialmente resolvida, conforme o contrato vigente. Não há resultados de testes novos nesta atualização documental.

## Histórico de G1.1 — proposta T1 antes da aprovação

Código/consumidores inspecionados: main-runtime, Main IPC policy, host Management, Preloads/janelas, media runtime/playback contracts, manifests/lock e convenções de teste Windows/CI. Documentação oficial Electron/Node/ws/selfsigned consultada, com fontes e ressalvas de versão na proposta. Dependências runtime ainda não existem no projeto; não foram instaladas. Quatro configurações de agentes preexistentes preservadas.

Limites e aprovações: proprietário deve aprovar o conjunto T1 (modelo TLS+bearer, confiança inicial, endereçamento/bind, manutenção anual, armazenamento seguro e dependências/quotas). T2 permanece separado e pendente. G1.1 não aprova TLS/pairing por implementação experimental e não abre portas para provar viabilidade.

Testes de aplicação, compile, Electron, Windows e certificados reais: NOT RUN por restrição explícita desta etapa. Revisão documental/links e `git diff --check` realizados ao concluir. Sem código de produção, firewall, Doop, F, commit, push ou PR. **G1.1 proposta concluída; T1 aguardando aprovação; G1.2/G1.3 não iniciadas.**

## Histórico — revisão T1 de renovação, armazenamento e revogação (bootstrap depois substituído pela decisão LAN)

Proposta revisada somente nesses três pontos (§5.5/5.6/6/16): manter certificado de 365 dias e novo vínculo guiado via descritor completo/QR sem PIN curto como confiança única; APIs Electron 45 verificadas por tipos e fonte da tag (Windows async, Linux caminho nativo sync verificável ou remoto desabilitado, com gate antes de Electron 46); revogação G2 em um único arquivo de autorização com escrita atômica e confirmação antes do sucesso, sem banco novo. Falha de persistência bloqueia processo corrente e nunca declara revogação durável; startup usa estado confirmado antes de autorizar. UX e testes futuros detalhados na proposta, sem editar Doop. T1 continua aguardando aprovação, G1.2/G1.3/G2 não iniciadas. Testes de aplicação não executados; `git diff --check` realizado ao concluir. Alterações preexistentes preservadas; sem commit/push.

## Histórico da revisão T1 — descoberta/pareamento integral LAN (antes da aprovação)

G1.2 acrescenta remote-discovery.ts, DiscoveryPort/candidatos não autorizados e BootstrapChannelFactory estritamente limitada. G1 implementa mDNS/DNS-SD e transport/TLS/quotas; nenhum SRP/consentimento de produção antes de G2. G1.3 testa TTL/goodbye, interfaces/UDP bloqueado, falsos anúncios/nomes, limites e lifecycle. Biblioteca descoberta proposta bonjour-service; ws/selfsigned mantidos. Não iniciar G1.2/G1.3. O texto anterior de interface manual/descritor foi substituído pela revisão LAN.

Referência técnica: [complemento T1 LAN](../../g1-1-t1-lan-pairing.md). Na data deste registro, a proposta aguardava aprovação e G1.2/G1.3 não estavam autorizadas. Estado atual e bloqueio posterior constam no registro de execução abaixo. T2/D2 e decisões funcionais aprovadas preservados.

## Registro histórico — bloqueio inicial antes do código

Na primeira tentativa de execução, a T1 pedia 128 bits e a implementação do pacote gerava nove bytes aleatórios, sem opção pública para serial customizado. Esse impasse foi resolvido depois pelo proprietário ao reduzir o mínimo para 64 bits de entropia; o requisito atual e a justificativa estão documentados na T1 vigente.

Esse registro descreve somente o estado anterior à aprovação do serial de 64 bits e foi superado pela execução subsequente. Os resultados atuais e limitações ambientais constam na seção de execução da proposta T1; não converter o bloqueio histórico em status vigente.

## Auditoria independente — parcial

[Achados, correções e evidências](../../g1-independent-audit.md). A correção anterior de erros WSS foi preservada. O cache Bonjour foi substituído por DNS-SD limitado por interface, com renovação/expiração TTL, atualização de endpoint, consulta periódica e regressões de carga/lifecycle. Harness TLS/WSS de dois processos reconecta após restart. Multicast real local PASS após correção do bind UDP e filtro de origem; smoke focalizado do módulo atual em ASAR PASS. Descoberta em LAN física entre computadores, validação nativa Windows e rebuild ASAR limpo permanecem pendentes. G1 não homologada; G2 não iniciada.

## Auditoria independente final — 2026-11-12

Parecer do Sol: **G1.2 PASS; G1.3 PARTIAL; tecnicamente apta para iniciar G2: SIM; integralmente homologada: NÃO.** Nenhum defeito crítico/alto ou bloqueador técnico novo foi encontrado. Foram repetidos compile, grupo remoto 27/27, multicast local 1/1, Electron Linux fail-closed e smoke focalizado ASAR. Windows nativo permanece NOT RUN porque o runner bloqueou um arquivo-fonte pelo nome antes de sincronizar; rebuild limpo segue pendente por DNS indisponível; validação em LAN física fica para G6. A recomendação técnica não satisfaz o pré-requisito de aprovação da G1, não autoriza iniciar G2, e não altera a exigência de autorização separada do proprietário.
