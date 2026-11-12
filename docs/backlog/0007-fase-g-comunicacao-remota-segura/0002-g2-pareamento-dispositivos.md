# 0007/0002 — G2: Pareamento de dispositivos

## Identificação e estado

- Ticket: 0007/0002
- Etapa canônica: G2; pai 0007 — Comunicação remota segura.
- Status atual: reauditoria final **PASS**; A4 **PASS**, A1–A3 **PASS**, G2.2/G2.3 **PASS**. G2 tecnicamente apta para iniciar G3; G3 não iniciada. Produção NÃO homologada, aguardando G5 e G6/H5. [Relatório Sol](../../g2-independent-audit.md).
- [Roadmap](../../standalone-player-roadmap.md), [contrato funcional](../../paired-mode-contract.md), [sequência e matriz de testes](../../paired-mode-execution-plan.md), [interfaces/IDs](../../paired-mode-ui-plan.md).

## Objetivo e limite

Autorizar um Controller por Player, com consentimento e revogação verificáveis.

## Pré-requisitos e dependências

G1 aprovada; T1 fechada; contrato de controlEpoch G3.1 descrito no plano, sem depender de integração H.

## Módulos envolvidos

Identidades e adapters G1; `PairingStore`, `PairingAuthorizationAdapter`, `PairingBootstrapService`, `PairingControllerClient`, `PairingRenewalCoordinator` e workers OPAQUE em Main. A interface de apresentação permanece um port sem UI de produto; não liberar por este ticket antes de G5.

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

Referência técnica: [complemento T1 LAN](../../g1-1-t1-lan-pairing.md), aprovado como direção T1; composição criptográfica permanece sujeita ao gate G2.1. Nenhuma implementação/teste de aplicação, alteração Doop ou início automático autorizado. T2/D2 e decisões funcionais aprovadas preservados.

## G2.1 — análise autorizada em 2026-11-12

[Proposta técnica e contrato candidato](../../g2-1-secure-pairing-contract.md): biblioteca/perfil, transcript/binding, estados, interfaces, persistência bilateral, recuperação, renovação, integração G1 e matriz obrigatória para G2.2/G2.3. Escopo desta autorização é exclusivamente análise/documentação; não autoriza os lotes de implementação.

Achados: params[3072] usa SHA-256 e params.hap usa SHA-512; fonte upstream usa comparação de strings para provas e exponenciação variável; artefato publicado, vetores/interoperabilidade e desempenho Electron não qualificados. G1 oferece probe/canal candidato pinado e ports bootstrap/deny-all, mas não store de vínculo, receipts, cancelamento do handler ou staging para renovar identidade expirada. Ajustes mínimos propostos, sem alterar G1.

Persistência proposta distingue pending/committed/active e resultado incerto; não promete atomicidade entre computadores. Schemas criptográficos/receipts finais, qualificação da biblioteca e decisões adicionais de lockout/renovação ficam explicitamente pendentes. Não entregar ao Luna como wire contract aprovado.

Working tree inicialmente limpa. Alterações exclusivamente documentais; sem dependências, código de produção, Doop, F, firewall, commit/push/PR. Testes criptográficos/aplicação/compile/Electron/Windows NOT RUN, pois não houve implementação nem instalação; isso impede alegar validação criptográfica PASS. Verificação documental registrada ao concluir a rodada.

**G2.1: BLOQUEADA para aprovação técnica (proposta entregue). SRP + binding TLS: REVISÃO NECESSÁRIA. Contratos G2.2/G2.3: PENDENTES. Aprovação do proprietário: AGUARDANDO. Implementação G2: NÃO INICIADA.**

Revisão independente documental do Sol concluída: manter bloqueio; sem falha grave demonstrável de binding, condicionada às hipóteses PAKE. Ressalvou que chaves commit derivadas de K não podem ser presumidas reconstruíveis a partir de recoveryKey; fechar árvore, receipts, revisões e vetores antes de implementar. Nenhum teste criptográfico executado. Links locais/whitespace e `git diff --check` PASS nesta rodada.

## G2.1 — retomada técnica autorizada, 2026-11-12

[Contrato §11](../../g2-1-secure-pairing-contract.md#11-retomada-executável--contrato-fechado-proposto-kq-pair1) e [evidências](../../evidence/g21/README.md) supersedem as pendências de árvore/receipts do draft. B1 PASS para artefato e vetores executados: npm 2.0.4 SHA512 conferido, JS publicado recompilado do gitHead com TypeScript 4.4.3, notices/MIT/jsbn inspecionados; SRP real confrontado com HAP-python e pysrp no vetor conhecido. B2 PASS para contrato proposto: R deriva de K e todas as chaves commit/recovery derivam de R desde o início; bytes, schemas, cinco receipts, recovery, CAS/revisões e renovação revoga-primeiro especificados.

Harnesses novos exclusivamente em scripts/validation, dependências externas temporárias em /tmp; nenhuma alteração de produção/package.json/lock/CI. PASS Node 24.15 e Electron 45 Run-As-Node/Node 24.22 (não UI/E2E): provas inválidas/replay/reflection, valores públicos, fault injection u=0, HKDF RFC5869 e transcript alterado. PASS HTTPS real com dois certificados fictícios e rejeição de substituição; modelo de persistência em processos novos com sete cortes/ACK perdido/tombstone; Python cryptography confirmou árvore, receipts e recovery MACs. Custo ~1 s por troca completa: worker obrigatório na futura implementação.

B3 BLOCKED: faltam qualificação/mitigação verificável dos canais laterais do provider variável; nenhum ataque de extração de senha foi demonstrado. Guards de u=0/largura e worker são contratos futuros, não código implementado. Vetores independentes fixos não comprovam interop em todas as bordas de padding. Sem auditoria universal da composição, assinatura npm validada, cofre/Windows, power-loss ou E2E G2; testes de produto não executados porque implementação não existe. G1 e suas limitações preservadas.

Proprietário ainda deve decidir política adicional de lockout persistente/renovação revoga-primeiro e direção da qualificação do provider; não dispensar B3 por aprovação administrativa. G2.1 tecnicamente pronta: NÃO. Contrato liberado ao Luna: NÃO. G2.2/G2.3 NÃO INICIADAS.

Revisão documental Sol da retomada concluída: árvore coerente; B1/B2 somente nos alcances delimitados, B3 bloqueado. Teste TLS final usa fórmula player-bind exata e DER observado (PASS); recovery é modelo, com MACs conferidos separadamente, não protocolo bilateral implementado. Sintaxe dos três harnesses Node, JSON/links locais/whitespace e `git diff --check`: PASS. Nenhuma suíte da aplicação/Windows foi executada nesta retomada.

## G2.1 — decisão final de segurança B3, 2026-11-12

[Contrato §12](../../g2-1-secure-pairing-contract.md#12-decisão-final-b3-lockout-e-renovação--retomada-de-2026-11-12): não aprovar fast-srp-hap@2.0.4 para produção. Não foi demonstrada extração de senha contra o pacote, mas quotas/worker não eliminam canais laterais. PARASITE demonstra que um único traço pode bastar em outras implementações SRP; a avaliação específica jsbn/V8/g^x e comparação de provas continua ausente. Não reatribuir o ataque OpenSSL ao jsbn.

Experimentos B3 isolados: Node24.15/Electron45 Run-As-Node PASS para worker SRP com fixture anterior, supervisor responsivo, cancel/exit sem resultado e worker seguinte funcional. OPAQUE1.1.0 real PASS para troca bilateral e negativos de senha/KE2/KE3; SPAKE2-wasm0.2.0 smoke PASS, sem oráculos independentes para essas alternativas. Integrity de tarballs conferida; payload SLSA OPAQUE aponta commit ca1cb22f03b9e456159ce367e2975124f87f5ad8 e digest confere, mas assinatura não validada. Resultados em evidence/g21/b3-*.json; scripts de experimento em scripts/validation/g21-b3-*. Nenhum consumidor de produção alterado.

Diagnóstico: B3 BLOCKED, provider aprovado NENHUM. Alvo mais viável @serenity-kit/opaque@1.1.0: histórico de revisão específico e WASM funcional, sem presumir que auditoria2023 cobre release2026. Gate delimitado: proveniência/delta de fonte e backend secreto, vetores RFC/suite independentes + binding kq-pair/2, worker/ASAR Windows. Não iniciar nova pesquisa genérica nem trocar protocolo sem aprovação. B1/B2 continuam válidos; deltas de uma eventual substituição estão mapeados, não implementados.

Lockout resistente a reinício foi aprovado como direção nesta solicitação. Contrato usa mesmo arquivo G2 de autoridade planejado/FS existente, reserva durável antes de custo, até5 falhas/reservas globais em10min e3 por sessão. Entradas sobreviventes recebem cooldown monotônico conservador de600s por boot, sem depender de RTC; processo aberto10min permite expiração durável. Falha de storage bloqueia pairing, sem afetar playback local. Modelo executável PASS, sem alegar store real.

Renovação proposta mudou de revoga-primeiro para preparar/cifrar/validar/stage antes de revogar; tombstone + promoting no mesmo commit de autoridade, depois promoção idempotente por fingerprint. Preserva bundle antigo recuperável, nunca reativa sua autoridade após tombstone, não aceita expirado e exige novo código guiado. Modelo com6 cortes PASS; power-loss/NTFS/cofre/IPC reais NOT RUN.

Pendências do proprietário: direção SRP qualificado versus caminho OPAQUE delimitado; aprovação da política stage-first e revisão da espera conservadora por boot. Não é pedido de autorização para o trabalho já executado. G2.1 tecnicamente pronta NÃO; contrato liberado ao Luna NÃO. G2.2/G2.3 NÃO INICIADAS.

## G2.1 — qualificação focal OPAQUE1.1.0

[Contrato §13](../../g2-1-secure-pairing-contract.md#13-qualificação-opaque-110--decisão-de-adoção) e [evidências reproduzíveis](../../evidence/g21/opaque-final/README.md). NO-GO para adoção atual, sem afirmar insegurança matemática ou incompatibilidade inevitável de UX. B1/B2 preservados.

Proveniência avançou: Sigstore4.1.0 verificou assinatura/cadeia/CT/Rekor com identidade do workflow e issuer GitHub exigidos; subject confere com tarball/commitca1cb22f03b9e456159ce367e2975124f87f5ad8. Não é rebuild reproduzível. Diff com checkpoint2023 (não alegado como commit auditado) confirma opaque-ke3-pre→4, KSF customizada e atualizações de glue/serialização; auditoria2023 não cobre automaticamente release2026. OSV sem advisories nos dois pacotes diretos consultados, sem garantia sobre transitivas.

Registro pela LAN/TLS candidato não satisfaz RFC9807. PoC executou registro inteiro local no Player; depois Gestão usa login/código e identifiers autenticados com fingerprint observado. Não exige outro PAKE prévio, mas a composição final não foi aprovada. PASS em Node/Electron45: dois vetores oficiais parciais de resposta OPRF/registro, HTTPS bilateral, código incorreto, KE2 adulterado, IDs/contexto experimentais, MITM TLS com dois certificados, troca após pin, replay KE3 e descarte de estado. ASAR/worker Electron45 PASS. Memória/custo e limitações registrados.

Bloqueios concretos: AKE completo com oráculo independente da suite/KSF real não executado; API pública fixa contexto vazio e só expõe Argon2, enquanto vetores RFC usam Identity/contexto explícito. Não se fez fork ou criptografia própria. Delta criptográfico pós-auditoria/grafo Rust resolvido do WASM ainda não qualificados; Windows nativo NOT RUN, runner oficial sem seleção deste PoC e não contornado. Não tratar handshake consigo mesmo ou vetores só de registro como qualificação total.

Sem novo perfil OPAQUE congelado ou troca silenciosa de T1. Provider aprovado NENHUM; PAKE balanceado RFC9382 é conceitualmente mais direto, mas nenhum provider alternativo qualificado foi comprovado nesta investigação. Não iniciar nova busca genérica nem implementação. Lockout persistente e renovação stage-first mantidos como propostas; detalhes ainda exigem aceite do proprietário. B3 BLOCKED, G2.1 pronta NÃO, contrato para Luna NÃO, aprovação AGUARDANDO.

Revisão Sol de §13 concluída, somente leitura: conclusão NO-GO de adoção e B3 BLOCKED coerentes; pré-provisionamento local plausível, sem elevar TLS candidato a confiança nem vetores parciais a AKE completo. Sigstore rejeitou payload adulterado. Sintaxe/JSON/links/whitespace e `git diff --check` PASS. Nenhuma implementação ou autorização da próxima etapa inferida.

## G2.1 — decisão arquitetural FINAL para o proprietário

[Perfil implementável](../../g2-1-final-pairing-profile.md) é a recomendação vigente; [histórico §14](../../g2-1-secure-pairing-contract.md#14-decisão-arquitetural-final--recomendação-única) preserva os NO-GO anteriores. Escolha única: OPAQUE-3DH, @serenity-kit/opaque1.1.0 exato, kq-pair/2. Apta para aprovação arquitetural proporcional, não produto habilitado. A solicitação final autoriza avaliar lacunas como trade-offs informados; ausência de auditoria nova/full AKE independente não é isoladamente bloqueio infinito. Nenhuma vulnerabilidade grave demonstrada foi ignorada.

Código8 digitado preservado. SAS completo foi comparado (Matrix/ZRTP/Bluetooth); não será criada comparação numérica própria nem extraída parte de Bluetooth. SRP/jsbn e demais substituições foram rejeitados por conjunto de evidência/custo/manutenção. CTX/encoding, identifiers OPAQUE, suite/versão, KDF/binding, mensagens/estados, receipts/recovery/revogação, worker/limites e renovação estão fechados no perfil. Segredos não chegam ao Renderer; G1 deny-all/ports reutilizados sem reabrir sua homologação.

Experimento adicional em dois processos com criptografia real cobre contexto/code/cert/nonce/geração, confirmações, replay e descarte; modelos de timeout/concorrência não são validação de store/coordinator reais. Python confere primitivas/transcript independentemente. Evidências em evidence/g21/final-decision; resultados anteriores válidos preservados. Correções da revisão Sol: persistir T completo no pending; alinhar userIdentifier do harness; padronizar REVISION_CONFLICT.

Riscos aceitos na recomendação: auditorias históricas sem extensão automática ao release/perfil, full AKE não reproduzido pelo wrapper, custo/memória Argon2 e worker, observação física/código/endpoints comprometidos, Windows/ASAR nativo e homologação posteriores, cooldown de até10min extra após boot. Não declarados PASS de testes ausentes. Lockout persistente sem novo banco e renovação stage-first são propostas finais para aprovação.

Próximo passo exclusivamente decisão do proprietário. Se aprovar, autorizar G2.2 ao Luna com este contrato; G2.3 valida implementação/FS/cofre/races/Windows. UI G5 aprovada e reconciliação G4/H continuam gates de ativação/controle. Nenhuma instalação permanente, produção, Doop, F, firewall, commit/push/PR. G2.1 READY FOR OWNER DECISION: SIM; G2.2/G2.3 NÃO INICIADAS; PROPRIETÁRIO AGUARDANDO DECISÃO.

Checagem final dos contratos G1: vínculo active concede apenas transport:control, escopo técnico exigido no Upgrade; zero autorização/rotas/messagePort de negócio G2. Guardas G1 preservados. Cinco receipts e recovery bound/prepareDigest v2 também conferidos entre Python/Node; Node e Electron45 em processos separados passaram. Sintaxe/JSON/links/whitespace e git diff --check PASS na entrega final.


## G2.2/G2.3 — implementação autorizada e validação incremental, 2026-11-12 (registro inicial)

O proprietário autorizou a implementação consecutiva do perfil final. Implementados os dez lotes G2.2: wire schemas versionados; OPAQUE real em worker Main-owned; registro/código local CSPRNG e consentimento via port; sessão única/cancelamento; binding de transcript/certificado e proofs; cinco receipts com persistência bilateral/recovery idempotente; bearer por Player, revogação e deny-all; lockout persistente; renovação anual stage-first; integração mínima com G1. Nenhuma rota operacional H ou reconexão G4 foi criada. Sem port real e aprovado, `PairingBootstrapService` permanece desativado. Não houve alteração Doop/F/firewall nem commit.

G2.3 automatizada: `npm run compile` PASS; `npm run test:unit:pairing` PASS para OPAQUE/worker, bootstrap, lifecycle, transcript/receipts, store/lockout, wire e renovação. O teste de processo não encontrou interface RFC1918 no sandbox padrão e marcou NOT RUN; executado separadamente com acesso de rede aprovado, passou com Gestão e Player em processos distintos, HTTPS/TLS pinado e OPAQUE real. Cenários confirmados: código errado e retry, certificado de falsa descoberta recusado antes do estado de confiança, ACK de prepare/active perdido e recovery, vínculo após restart, revogação persistente após restart e shutdown pós-commit sem resultado de cancelamento espúrio. Regressões G1 `remote-infrastructure` 18/18 e teste do seletor Windows 38/38 PASS. Teste Linux Electron 45 Run-As-Node com `app.asar` real, worker e pacote WASM passou.

Três smokes Windows oficiais: **NOT RUN** naquele registro inicial. O runner padrão não tinha checkout selecionado e o checkout NTFS isolado recusou `src/remote-secret-protector.ts` pela classificação conservadora. Esse estado foi corrigido e substituído pela validação final documentada a seguir; mantém-se como histórico da primeira tentativa.

**Status:** G2.2 **PASS** como implementação técnica do contrato; G2.3 **PARTIAL** pelas validações Windows não executadas. Apta para auditoria independente: **SIM**; homologada para produção Windows: **NÃO**. Pareamento de produção aguarda apresentação local real e aprovada em G5. G3 não iniciada. Nenhuma aprovação de produção presumida.

## G2.3 — desbloqueio e três smokes Windows, 2026-11-12

O `isSensitivePath` bloqueava `src/remote-secret-protector.ts` porque o nome contém o segmento `secret`. Após inspeção do conteúdo source-only, o runner passou a aceitar somente o caminho exato com SHA-256 LF/CRLF revisados, e somente nos estados Git `tracked`/`adopted`. Untracked, arquivos adjacentes e hashes diferentes continuam bloqueados. O primeiro clone revelou `core.autocrlf=true`; a forma CRLF esperada foi fixada explicitamente. `scripts/windows-native-runner.test.cjs`: **39/39 PASS**.

No Windows nativo x64, Node `24.11.0`, npm `11.6.1`, Electron `45.0.0`, PowerShell `5.1.26100.9711`, `test:e2e:remote-infrastructure:windows -- --approve-untracked` passou: OPAQUE real em workers, integração em processos independentes Player/Management, safeStorage DPAPI com persistência/restart em dois processos Electron, e regressões HTTPS/WSS/discovery. A primeira execução revelou `write EBADF` no teste de shutdown: rejeição de autorização abortada ainda tentava escrever no socket encerrado. O caminho de catch agora destrói o socket e limpa a reserva sem resposta durante shutdown; regressão focada passou e a suíte remota Windows passou 18/18.

`package:windows:candidate -- --approve-untracked` passou no checkout NTFS novo. O primeiro candidato revelou incompatibilidade do helper: `@electron/asar` no Windows requer o separador nativo em `extractFile`, mas o verificador fornecia `/`. `scripts/verify-windows-build.cjs` usa agora `path.join`; o teste POSIX/Windows foi adicionado e `scripts/windows-build-provenance.test.cjs` passou 6/6. O runner recusou sobrescrever `dist/` parcial da tentativa anterior; esse checkout/candidato permaneceu preservado e a build final ocorreu num segundo checkout novo. O empacotador oficial selou e verificou 1.057 entradas ASAR; o Electron empacotado carregou worker Main-owned e efetuou registro OPAQUE real em `app.asar`: **PASS**. Candidato x64 SHA-256 `8af6dec349330b3daa51aeaf1fde11bc099b81379173f8c6dd31178f63ddc9a0`.

Smokes: **1 PASS**, **2 PASS**, **3 PASS**. G2.3: **PASS**; G2 apta para auditoria independente: **SIM**. G2 não está homologada para produção: interface G5 real/aprovada e demais gates continuam pendentes. O smoke mDNS multicast opt-in não foi solicitado; G6/H5 em máquinas físicas não executado. G3 não iniciada.

## Auditoria independente Sol — 2026-11-12

[Relatório final](../../g2-independent-audit.md): A1 cofre indisponível ainda autorizava; A2 escrita após restart apagava cooldown; A3 revogação durante staging falhava. Correções mínimas e regressões 3/3 PASS; store/renovação/OPAQUE e runner Windows oficial PASS, fingerprint `83c7783afed07048c2184926fb240e77768ae261fc3ebec818f1b143385a4301`. Evidências históricas dos três smokes preservadas.

**Achado A4 na auditoria inicial (resolvido na seção posterior):** `node scripts/pairing-bootstrap-integration.test.cjs --cancel-at-prepare` falhou com journal count 1 em vez de 0 após cancelLocally retornar true; OPAQUE real, barreira no cofre, sem sleeps. Exigia coordenar cancelamento/deadline com admissão e resultado incerto da escrita; apenas checar antes de um await não bastava. Naquele snapshot G2.2/G2.3 PARTIAL, auditoria FAIL e G3 bloqueada. G5/G6 e homologação de produção permanecem pendentes. Sem alteração de protocolo/Doop/F nem commit.

## Correção A4 — 2026-11-12

Foi criado ponto síncrono de admissão do primeiro journal depois do worker/cofre. Cancelamento que vence antes da admissão cerca a sessão e callbacks antigos não gravam; cancelamento posterior aguarda o resultado do store e relê o arquivo em falha. Só retorna confirmado se uma leitura durável provar ausência do journal. Journal presente fica `bound/pending`, sem `prepare` e sem autorização; leitura inconclusiva mantém `blocked/RESULT_UNCERTAIN`. Nada é apagado para mascarar resultado incerto. Duplicatas compartilham a operação de cancelamento; deadline é aplicada antes da admissão, shutdown reconcilia escrita já admitida.

Reexecutado reproducer original A4 com OPAQUE real: **PASS**. Também passaram cancelamento no cofre pendente, antes da admissão, após admissão, após rename/fsync mas antes do retorno, falha antes do commit, ACK perdido + restart, cancelamentos duplicados, shutdown durante escrita e negação de bearer em `bound`. Corrida de revogação durante renovação admitida passou fail-closed: revogação persistida, receipt seguinte recusado e journal bound mantido para recovery/revogação local explícita, sem liberar o slot. `npm run test:unit:pairing`: compilação e fluxos OPAQUE/bootstrap, A1–A3 (3/3), store (4/4), crypto (2/2), wire/state (3/3), renewal (1/1) **PASS**. Integração de processos independentes **NOT RUN** por ausência de IPv4 RFC1918. Sem novos smokes Windows, pois não houve mudança específica da plataforma.

Resultado: **A4 RESOLVIDO; G2 apta para reauditoria: SIM**. G2.2/G2.3 continuam PARTIAL até reauditoria independente; G3 não iniciada. G5, G6/H5 e homologação de produção seguem pendentes. Perfil `kq-pair/2`, Doop e F preservados; sem commit/push/PR.


## Reauditoria final A4 — 2026-11-12

Revisão focal e reexecução de `test:unit:pairing`: reproducer A4 OPAQUE real, barreiras, falhas/ACK perdido, restart, duplicatas, renovação/revogação e shutdown PASS; A1–A3 3/3 PASS. Nova regressão de escrita e releitura inconclusivas PASS: false/blocked, arquivo preservado e zero autorização. Sem defeito adicional de produção; nenhum ajuste arquitetural. Processo LAN NOT RUN sem RFC1918; Windows/ASAR não afetados e não repetidos. G2.2/G2.3 PASS, auditoria PASS; G2 apta para iniciar G3 SIM. G3 não iniciada; produção NÃO homologada, G5 e G6/H5 pendentes. `git diff --check` PASS.

## Auditoria final da working tree para checkpoint — 2026-11-12

Encontrada e corrigida uma regressão P2 no composition root: após `startPlayer()` terminar, uma segunda chamada poderia substituir os handles do servidor/anúncio ativos. A guarda voltou a rejeitar inicialização quando o Player já está ativo; regressão HTTPS local adicionada. `npm run compile` **PASS**, `remote-infrastructure` **19/19 PASS**, `test:unit:pairing` **PASS**, incluindo A1–A4. O subprocesso LAN foi **NOT RUN** por ausência de IPv4 RFC1918 neste ambiente; a execução anterior aprovada continua documentada. Smokes Windows não repetidos por não haver alteração específica de plataforma. A auditoria independente permanece **PASS**, G2.2/G2.3 **PASS**, apta para iniciar G3; G3 não iniciada. Produção NÃO homologada; G5 e G6/H5 pendentes.
