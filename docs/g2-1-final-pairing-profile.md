# G2.1 — Perfil final recomendado para decisão do proprietário

**Recomendação: OPAQUE-3DH, @serenity-kit/opaque@1.1.0, perfil `kq-pair/2`. APTA PARA APROVAÇÃO arquitetural.** Não é autorização de G2.2/G2.3 nem alegação de auditoria desta composição. Esta proposta encerra a investigação; o próximo gate é a decisão do proprietário. [Histórico e evidências](g2-1-secure-pairing-contract.md), [ticket G2](backlog/0007-fase-g-comunicacao-remota-segura/0002-g2-pareamento-dispositivos.md).

A solicitação final autorizou avaliar riscos proporcionais, inclusive comparação numérica. A recomendação anterior NO-GO do artefato por qualificação incompleta é histórica; a decisão atual aceita, de forma informada e delimitada, ausência do vetor AKE integral pelo wrapper e ausência de auditoria nova de cada delta. Não houve descoberta de vulnerabilidade grave que seja ignorada para fechar a etapa.

## 1. Decisão e critérios proporcionais

| Candidata | Segurança/evidência | Implementação/manutenção/dependências | Operador/G1/testabilidade | Decisão |
|---|---|---|---|---|
| SRP HAP / fast-srp-hap2.0.4 | Vetores e integridade positivos; expoentes secretos jsbn e comparação variáveis, sem exploração demonstrada neste app | CJS leve, zero transitivas npm; release antigo e guardas adicionais; worker não corrige canal lateral | Código8, G1 pronta; ótimos testes existentes | Não escolher: OPAQUE oferece conjunto de implementação/revisões mais favorável |
| OPAQUE / serenity1.1.0 | Proveniência Sigstore, dois vetores OPRF oficiais, core com histórico de revisão, negativos reais/TLS, fonte dos deltas inspecionada. AKE integral independente pelo wrapper ausente | Um pacote npm sem transitivas JS; Rust/WASM incorporados exigem inventário/notices; custo Argon2 exige worker | Mantém código8; registro local, pin e ports G1; ASAR/Electron comprovados; teste em dois processos acrescentado | **Escolhida**, com riscos residuais declarados |
| SAS / comparação numérica | Mecanismos sérios existem: Matrix SAS, ZRTP e Bluetooth; exigem compromisso/ordem/autenticação do transcript, não hash curto improvisado | Integração de identidade/eventos Matrix ou stack ZRTP/SMP amplia superfície; não há adapter independente qualificado na base atual | Comparação elimina digitação, mas não garante que humano compare; G1 precisaria contrato novo de troca/compromisso | Rejeitar como solução principal nesta base, sem declarar SAS inseguro |
| SPAKE2 ou stack consolidada alternativa | PAKE balanceado é conceitualmente direto; o WASM avaliado não superou a evidência do provider escolhido | Trocar por core nativo/novo wrapper introduziria build/qualificação sem ganho concreto já demonstrado | Nova suite/vetores/empacotamento; sem vantagem suficiente para trocar agora | Rejeitar nesta decisão, sem nova pesquisa aberta |

A análise SAS consultou [Matrix SAS](https://spec.matrix.org/v1.19/client-server-api/#short-authentication-string-sas-verification), sua implementação [matrix-sdk-crypto-wasm](https://github.com/matrix-org/matrix-sdk-crypto-wasm), [ZRTP RFC6189](https://www.rfc-editor.org/rfc/rfc6189) e [Bluetooth Numeric Comparison](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core-54/out/en/host/security-manager-specification.html). Matrix define compromisso da chave e confirmações ligadas à identidade/dispositivo; ZRTP acrescenta seu próprio handshake/transcript/estado de mídia; Bluetooth depende do protocolo completo de segurança do enlace. Não portar apenas a função decimal para TCP.

Um SAS corretamente comprometido com 10^8 valores uniformes teria chance ideal de coincidência acidental 10^-8 por tentativa e ≤5×10^-8 para cinco tentativas, além da probabilidade de erro humano. Esse número **não se aplica** a hash de certificado mostrado sem compromisso nem qualifica um protocolo específico. Não foi criado/testado um SAS novo. OPAQUE não tem falso aceite de comparação: o limite ideal de cinco palpites de código8 também é ≤5×10^-8, condicionado a código uniforme, PAKE correto e quotas; não cobre observação do código ou máquina comprometida.

Classificação de risco: nenhum ataque de impersonação contra o perfil executado foi demonstrado; SRP/jsbn tem fragilidade plausível; OPAQUE tem lacunas de auditoria/evidência, não vulnerabilidade comprovada. Ausência de auditoria nova/full vector não é isoladamente risco inaceitável. MITM sem binding, fallback inseguro, liberação antes da persistência e aceitar expirado são riscos inaceitáveis e continuam proibidos.

## 2. Dependências, suite e experiência

Dependência futura única: `@serenity-kit/opaque` **exata 1.1.0**, sem caret. Integrity `sha512-Y6v/+hRMn0MdMEk5+/ArM0vPIiFfFEbdTZc7oAx+cWyvGODGezAQ/sMjXBVogf7NsS9z9EV0Ve5paZCVULuedw==`; SHA256 tarball `7ea879bb56cefddf59216a0242936e595ff9310ef4b6efa4111256e6834b94ab`. Proveniência verificada aponta commit `ca1cb22f03b9e456159ce367e2975124f87f5ad8`. Sem fork, matemática própria ou atualização automática de perfil. Manter APIs/primitivas `node:crypto`: randomBytes/randomInt, SHA256, HKDF-SHA256, HMAC-SHA256, timingSafeEqual. Reutilizar G1/TLS/cofre existentes. A operação do pareamento é offline: WASM inline e RNG do SO, sem API externa; Sigstore foi ferramenta de qualificação em desenvolvimento, não dependência de rede no produto. Transitivas Rust incorporadas não equivalem a ausência de dependências criptográficas; preservar notices/inventário do artefato.

Profile ASCII exato: `opaque-3dh-ristretto255-sha512-argon2id-m65536-t3-p4`. OPRF ristretto255-SHA512, TripleDH Ristretto255/SHA512 e chave compartilhada64 bytes; default do wrapper Argon2id1.3, memória65536 KiB/iterações3/paralelismo4. Chamadas finishRegistration/finishLogin sempre recebem `keyStretching: 'memory-constrained'`; nunca aceitar configuração remota/custom/“rfc-recommended”. Contexto nativo opcional é vazio na API; o contexto da aplicação entra nos **identifiers autenticados nativos**, conforme §3. Não alegar que uma propriedade JS `context` seja processada.

Fluxo exato: Gestão descobre → operador clica Dispositivos à esquerda do sino → seleciona Player → Player pede permissão local mostrando nome informado/não verificado → operador permite → Player gera/exibe código8 agrupado4–4 → operador digita na Gestão e confirma → ambos autenticam, salvam e exibem vínculo, aguardando reconciliação. Aceitar no Player e confirmar entrada na Gestão constituem autorização local bilateral; não há clique remoto simulando consentimento. Nenhum código, certificado ou QR é comparado manualmente. Reinícios/conexões usam vínculo salvo; renovação repete o mesmo fluxo.

Código: randomInt(0,100000000), padStart8, exatamente ASCII0–9, uso em uma sessão; Main remove só o separador visual previsto. Renderer só recebe código efêmero na apresentação Player autorizada e transmite input pela IPC específica Gestão. Nenhuma chave/record/setup/sessionKey/R/token no Renderer. UI G5 precisa referência aprovada e superfície local que não projete código na TV; apresentação restrita ausente mantém bootstrap de produção desabilitado.

## 3. Encoding, contexto e autenticação inicial

E(f1,…,fn) = concat(uint32be(len(fi)), fi). ASCII para labels/versões/UUID/inteiros canônicos sem zeros iniciais; binários crus para IDs aleatórios, nonces e fingerprint. Base64url no JSON é sem padding, decode/reencode idêntico. UUIDv4 minúsculo36 bytes. Inteiros são **strings** decimais 0..Number.MAX_SAFE_INTEGER−16; não JSON number. SessionId/operationId/attemptId/nonceC/nonceP/capability/pairingId são32 bytes CSPRNG independentes. Fingerprint é SHA256(DER)32, não PEM/TXT. Sempre version2, sem negociação ou fallback para SRP/v1/SAS.

CTX tem exatamente esta ordem de campos:

```
E('KQ-Pair-context','kq-pair/2',profile,purpose,
  sessionId,operationId,attemptId,nonceC,nonceP,
  controllerId,playerId,'controller','player',fingerprint,
  serverName,expectedGeneration,targetGeneration,
  basePRevision,baseCRevision,'120')
```

purpose=`initial|renewal`; profile fixo acima. serverName é o SAN G1 `player-<playerId>.karaoke.invalid`. targetGeneration=expectedGeneration+1; basePRevision/baseCRevision são revisões de **autoridade**, não storeRevision de quota. IDs/nome/protocolo mDNS não conferem autoridade. Player usa identidade, revisão e DER locais do listener; Gestão usa seu ID persistente e o DER realmente validado no socket candidato. Gestão exige serverName/playerId compatíveis com o cert e com o pedido selecionado. No open, Gestão não precisa conhecer a geração do Player: ele devolve expectedGeneration/targetGeneration da autoridade local; Gestão confere target=expected+1 e só os autentica pelo AKE. O valor recebido nunca revoga ou substitui vínculo. Campos alegados do peer só viram confiáveis após AKE/binding.

Identifiers nativos exatos, ASCII:

```
client = 'KQ-Pair-v2/controller/' + base64url(CTX)
server = 'KQ-Pair-v2/player/'     + base64url(CTX)
```

A mesma dupla é fornecida em finishRegistration, server.startLogin, client.finishLogin e server.finishLogin. Em cada lado CTX é reconstruído dos valores locais/negociados congelados; nunca aceitar CTX pronto do peer como autoridade. Um fingerprint, nonce, papel, ID, geração ou finalidade divergente impede autenticação. Cachear CTX por tentativa não autoriza reaproveitá-lo em outra.

**Registro é 100% local no Player:** depois de consentimento/código e reserva de tentativa, worker cria setup com server.createSetup; executa client.startRegistration(password), server.createRegistrationResponse(setup, userIdentifier,request), client.finishRegistration(password,identifiers,keyStretching). userIdentifier=`KQ-Pair-v2/`+base64url(sessionId)+`/`+base64url(attemptId). Setup/record/exportKey ficam só no worker; exportKey é descartada. Não expor rota de registro ou aceitar record remoto. Criar setup/record novos por tentativa, salt/OPRF aleatórios da biblioteca. Não há banco de contas OPAQUE nem confiança em TLS provisório no registro; trata-se de pré-provisionamento numa fronteira local confiável. A digitação do código autentica o AKE seguinte.

Gestão worker: client.startLogin(password) → KE1. Player worker: server.startLogin(setup,record,userIdentifier,KE1,identifiers) → KE2/estado. Gestão: finishLogin com identifiers/password/profile → KE3/K, ou falha. Player: finishLogin(estado,KE3,identifiers) → K, ou falha. Larguras binárias: KE1=96, KE2=320, KE3=64, K=64 bytes. Não usar exportKey como K. K e estados OPAQUE nunca saem do provider ao Renderer; o Main recebe só material estritamente necessário ao seu store protegido.

A probabilidade/segurança do código depende da implementação PAKE; não se envia senha, hash direto ou verifier em rede. OPAQUE fornece provas nativas; antes de o Player verificar KE3 ele não envia confirmação de binding, trust ou token. O probe G1 continua sem HTTP/auth; createBootstrapChannel fica pinado no candidato e restrito às três rotas. Operacional só usa TLS estrito/pin persistido e bearer individual após vínculo confirmado.

## 4. Transcript, chaves e confirmação bilateral

```
T  = E('KQ-Pair-transcript','kq-pair/2',profile,CTX,KE1,KE2,KE3)
TH = SHA256(T)
Dkey(IKM,label) = HKDF-SHA256(IKM, salt=TH,
                            info=E('KQ-Pair-v2',label), length=32)
kBindP = Dkey(K,'bind-player'); kBindC = Dkey(K,'bind-controller')
R = Dkey(K,'recovery-root')
kCP=Dkey(R,'commit-player'); kCC=Dkey(R,'commit-controller')
kQP=Dkey(R,'recovery-player'); kQC=Dkey(R,'recovery-controller')
playerBind = HMAC-SHA256(kBindP,E('player-bind',TH,KE1,KE2,KE3))
controllerBind = HMAC-SHA256(kBindC,
                   E('controller-bind',TH,KE1,KE2,KE3,playerBind))
```

Todos os KE são bytes crus; MACs32 bytes, comparação timingSafeEqual após largura exata. Player emite playerBind só depois do finishLogin válido; Gestão valida e responde controllerBind; Player valida antes de gerar/preparar credencial. São confirmações/KDF da aplicação com primitivas padronizadas, reutilizando B2, não novo PAKE. O binding ao cert já está dentro do AKE pelos identifiers; estes MACs confirmam o transcript final/aceite do outro lado. Não liberar controle por “TLS pronto”, “KE2 recebido” ou “código preenchido”.

Persistir somente R cifrada para recuperar transação, nunca K/kBind/a/b/record/setup/exportKey/código. Chaves commit/recovery derivam **desde o início de R**, sem tentar inverter HKDF. Após confirmação e preparação local, destruir worker e seus estados (best-effort de memória, sem promessa de apagamento garantido). Cancelar aguarda terminate/exit e cerca callbacks por geração. Worker é responsividade, não fronteira contra malware/cache local.

## 5. Mensagens fechadas sobre G1

Somente POST `/v1/pair/request|proof|confirm`, com JSON, sem Authorization/Cookie/Origin/query/redirect. Corpo≤16KiB, UTF8 fatal, profundidade≤6. Envelope de chaves exatas `{version,type,sessionId,operationId,attemptId,payload}`, version='kq-pair/2'. IDs JSON em base64url. Antes de gerados, sessionId/attemptId são string vazia: open usa ambos vazios; poll/cancel/estado anterior à tentativa usam attemptId vazio. Respostas ecoam IDs congelados. Campos não previstos são erro.

Wire JSON compacto = JSON.stringify de objeto validado, sem whitespace externo/interno extra; receptor parseia, valida chaves/tipos e exige resserialização idêntica, rejeitando chaves duplicadas. MAC usa E, nunca o JSON. displayName é texto não verificado até64 code points, sem controles/surrogates inválidos; demais strings conforme enums/formatos. Não usar payload de erro ou nome em HTML/log bruto.

| Rota/type | Chaves exatas do payload |
|---|---|
| request/open | controllerId,displayName,nonceC,purpose,baseCRevision,profile |
| response/opened | playerId,nonceP,sessionCapability,basePRevision,expectedGeneration,targetGeneration,serverName,fingerprint,state |
| request/poll ou cancel | sessionCapability |
| response/state | state,remainingSeconds,attemptsRemaining |
| proof/ake-start | sessionCapability,KE1 |
| response/ake-response | KE2 |
| proof/ake-finish | KE3 |
| response/ake-confirmed | playerBind |
| confirm/controller-bind | controllerBind |
| response/prepare | transcript,descriptor,token,receipt |
| confirm/prepared | receipt |
| response/committed | receipt |
| confirm/final | receipt |
| response/active | receipt |
| confirm/status | pairingId,nonce,localPhase,receiptDigest,mac |
| response/status-result | pairingId,nonce,phase,receiptDigest,receipts,prepare,mac |
| response/error | code,state |

receipt=`{type,tag}`; prepare em status é null ou `{transcript,descriptor,token,receipt}` conforme §7. token32 bytes/base64url43 caracteres, TH/digests32, T/B binários em base64url. remainingSeconds e attemptsRemaining são strings canônicas0..120 e0..3. state/phase da máquina abaixo; erros genéricos sem prova/código/chave/caminho em resposta/log.

open não autoriza sessão concorrente. sessionCapability é32 bytes aleatórios Main-only, permite só poll/cancel/ake-start daquele pedido; não é identidade nem bearer operacional. ake-finish só é admitido após KE1 daquela tentativa. operationId identifica a intenção open e fica fixo; attemptId novo por tentativa, escolhido pelo Main Gestão antes do KE1. Requests por etapa têm bytes/hash cacheados: duplicata idêntica retorna resultado guardado/junta Promise, nunca reexecuta provider; mesmo ID com conteúdo diverso falha REVISION_CONFLICT. Após erro, novo attemptId/KE1 e setup/record novos; no máximo3 tentativas na mesma sessão consentida. Se Gestão rejeita KE2 e não há KE3, novo ake-start com capability válida só pode substituir tentativa em awaiting-KE3/code-ready: cobrar a anterior conservadoramente, destruir estado antigo e reservar a nova atomicamente. Durante preparing-attempt retornar BUSY/202; após binding/pending não substituir. KE3 antigo, mesmo válido criptograficamente, é recusado pelo attemptId cercado. Repetir o mesmo ake-start continua idempotente, sem nova reserva. Não ligar sessão ao connectionId G1, que muda por HTTP request.

Durante consentimento/preparação, poll espaçado em no mínimo10s, uma requisição pendente; não ocupar HTTP aguardando decisão humana. Respeitar quotas G1: HTTP429 antes de admissão não é prova incorreta; reagendar de forma limitada pelo Clock (mínimo6s se não houver Retry-After), com IDs/bytes originais e revalidando deadline, nunca gerar outra intenção ou repetir mutação incerta cegamente.

HTTP200 para resultado,202 para espera/preparação,400 inválido/versão/profile,403 rejeição/auth,409 busy/already-bound/conflito,410 expiração,429 quota,503 storage/uncerto. Codes: BUSY,ALREADY_BOUND,REJECTED,EXPIRED,RATE_LIMITED,INVALID_MESSAGE,AUTH_FAILED,REVISION_CONFLICT,STORAGE_UNAVAILABLE,RESULT_UNCERTAIN. Versão/profile errados terminam sem fallback.

## 6. Estados, consentimento e concorrência

Player: idle-unbound → awaiting-local-consent → code-ready → preparing-attempt → awaiting-KE3 → awaiting-controller-bind → pending → committed → active. Gestão: selected → requested → waiting-consent → awaiting-code → preparing-KE1 → verifying-KE2 → awaiting-player-bind → saving-prepared → awaiting-commit → saving-committed → awaiting-active → active-awaiting-reconciliation. rejected/cancelled/timed-out/error são terminais antes da admissão do primeiro journal; após admissão, incerteza exige consulta, nunca rollback presumido. blocked/revoked são fail-closed.

Espera de consentimento≤120s e validade do código120s desde aceitar no Player, monotônica e sem renovação por poll. Verificar deadline antes/depois de await/worker e antes de emitir KE2/bind/prepare. Sem nova admissão após cancel/offline/shutdown/generation change. Para o primeiro journal, o Main faz a decisão de admissão sincronicamente, após as operações do worker/cofre: se o cancelamento vencer essa decisão, gravação posterior daquela sessão fica proibida; se a admissão vencer, cancelamento espera o resultado e a releitura durável. Só retorna confirmado quando a leitura prova que não há journal daquela sessão/operation/attempt e a sessão fica cercada. Se o journal existir, preservá-lo como bound/pending e não publicar prepare após intenção de cancelar; se a leitura não resolver o resultado, marcar blocked/RESULT_UNCERTAIN, preservar qualquer arquivo e não autorizar. Nesses dois casos cancelamento não é confirmado; a Gestão resolve por recovery autenticado. A transação já preparada usa recovery autenticado e não é apagada por esse TTL.

Um slot reservado por Player, inclusive durante playback e pending/uncertain; segundo Controller recebe ocupado/já vinculado. Nunca revogar por request remoto. Nenhum pedido/consentimento pausa ou para música; se não houver apresentação local segura, recusar bootstrap. Na Gestão, só uma sessão de pairing e um worker ativos por processo (vínculos salvos podem incluir vários Players), sem rodar tentativas para cada anúncio. O Player também mantém um único worker de pairing. Não confundir esse limite com seleção/autorização de controle operacional futuro. Revogar/reset/session cancel/workers disputam a mesma fila de coordenação; serializar transições, não manter locks/transaction abertos aguardando operador ou rede. Cancelamento local retorna true somente quando a sessão foi cercada antes da admissão ou quando a reconciliação posterior confirma ausência durável; false significa não afirmar cancelamento e consultar estado/recovery. Cancelamento duplicado é idempotente. Fechamento aguarda uma admissão em curso e nunca apaga journal possivelmente válido. O estado volátil de admissão não é autoridade: somente Player `active` após os receipts concede a autorização técnica.

Ports Main-only: PairingCoordinator; LocalPairingPresentationPort; OpaqueWorkerPort; PairingStore com compare-and-persist/recover; Clock/RNG injetáveis. Sender/frame/WebContents e função validam IPC específica. Fixtures de consentimento só em testes; produto sem presentation port real aprovado mantém pairing disabled. G1 importa ports, nunca implementação G2; deny-all padrão continua íntegro. Reutilizar a mesma instância RemoteIdentityStore da composição Main para obter identidade Gestão, sem criar writer paralelo; adicionar só port Main restrito se necessário. Assegurar cofre disponível nos dois lados antes de abrir pedido. Bootstrap recebe metadata TLS validada do adapter, não um raw socket no domínio. connectionId/close de uma requisição HTTP não equivalem a cancelamento da sessão: agente pode abrir outro socket entre etapas. Abort/deadline por request cerca apenas seu waiter; sessão/attempt segue seu prazo/estado/cache e cancelamento explícito. Resultado perdido pode ser consultado/repetido; nenhuma callback posterior ao fence da sessão publica sucesso. Não criar fila/SQLite operacional novo.

## 7. Vínculo, receipts, recuperação e revogação

Reutilizar **§11.5–11.6 do histórico B2** com substituições explícitas version='kq-pair/2', TH de §4 e chaves/rótulo HKDF de §4. Prefixos E('KQ-Pair-record'), E('KQ-Pair-receipt') e E('KQ-Pair-recovery') permanecem; campo version muda para2. Nenhum registro/proof v1 é aceito como v2. Estes são os formatos completos:

```
B = E('KQ-Pair-record','kq-pair/2',TH,pairingId,operationId,
      targetGeneration,basePRevision,baseCRevision,SHA256(token))
D = SHA256(B)
Xi = E('KQ-Pair-receipt','kq-pair/2',type,TH,pairingId,operationId,
       targetGeneration,basePRevision,baseCRevision,SHA256(token),previous)
tag = HMAC-SHA256(keyDirection,Xi)
next = SHA256(E(type,tag))
```

previous0=D; demais=next anterior. Cadeia: prepare P/kCP → prepared C/kCC → committed P/kCP → final C/kCC → active P/kCP. Cada receipt só sai **depois de gravação/readback**: P pending(baseP+1); C prepared(baseC+1); P committed(baseP+2); C committed(baseC+2); P active(baseP+3); C active(baseC+3). A revisão é authorityRevision; CAS externo storeRevision também protege quota/metadata. Token/R cifrados via SecretProtector; Player mantém hash para authorizeBearer e envelope cifrado só para retransmissão. Receipts e B/D/TH/CTX e **T completo (com KE1/KE2/KE3)** ficam no journal pending/prepared e fases seguintes, permitindo reconstruir exatamente prepare após restart sem worker/K. São dados internos, nunca logs ou Renderer. Guardar também resultado/digests de cada intenção para dedupe. Startup lê antes da rede; escrita incerta/corrupção/decrypt falho bloqueiam autorização.

R/secretos nunca em log; zero escopo operacional de negócio G2, mesmo active. Para compatibilidade com a G1 real, authorizeBearer de vínculo active devolve exatamente o escopo técnico **transport:control** (exigido em remote-transport.ts no Upgrade), não array vazio. Esse grant fixo do perfil permite só HTTPS/WSS técnico/hello: nenhuma rota de playback/fila é criada ou liberada e nenhum messagePort de negócio é instalado por G2. A ausência do grant técnico impediria a conexão inicial prevista; não é preciso alterar o guard da G1. Requests de scopes adicionais não são admitidos. Estado não ativo/cofre indisponível/revogado retorna null; isCurrent confere slot/ID/geração/active após awaits. Após active e confirmação local, uma tentativa inicial de transporte pode usar o cliente G1 normal; falha de conexão não desfaz vínculo nem repete código. Reconexão automática fica G4. G4/H reconciliam depois; offline explícito não muda ao parear/reconectar. Slots/gerações/estado active são checados por RemoteAuthorizationPort e isCurrent após awaits; revogado/pendente não autentica /control. Não modificar G1 para aceitar bearer provisório.

Query status MAC kQC:

```
E('KQ-Pair-recovery','kq-pair/2','query',TH,pairingId,operationId,
  targetGeneration,nonce,localPhase,receiptDigest)
```

Resposta MAC kQP:

```
E('KQ-Pair-recovery','kq-pair/2','answer',TH,pairingId,operationId,
  targetGeneration,nonce,phase,receiptDigest,
  E(...E(type,tag) dos receipts em ordem),prepareDigest)
```

nonce32 fresco, uma consulta pendente por transação; resposta só aceita para nonce pendente, removido após consumo/cancelamento. receiptDigest=next do último receipt confirmado no journal local (P pending já tem prepare, portanto next0); Gestão bound sem journal usa32 bytes zero. Não usar D como substituto implícito de next. localPhase=`bound|prepared|committed|active`. Status é leitura; replay não regrava fases. TLS estrito ao pin válido daquela transação; nunca enviar R/token ao candidato renovado desconhecido.

**Delta explícito de recovery B2:** prepare=null normalmente, prepareDigest=32 bytes zero. Se P ainda tem pending e Gestão autentica status como bound/prepared com R e necessita a primeira resposta perdida, pode devolver prepare original idêntico; prepareDigest=SHA256(E(T,B,token,E(type,tag do receipt prepare))). Não emitir outro token/pairingId. D é recomputável pela Gestão só após receber prepare; para bound sem prepare, receiptDigest é32 bytes zero na query, aceito apenas nessa fase autenticada. Resposta autentica o D/prepare devolvidos; Gestão valida T contra contexto/KEs em RAM e B contra hashes/counters antes de persistir. Depois de prepared, validar TH/pin/IDs salvos e cadeia original; não repetir AKE.

Para consulta bound antes de conhecer pairingId (prepare perdido), permitir pairingId vazio somente nessa query; localizar o único pending pelos IDs sessionId/operationId/attemptId do envelope e TH local, verificar MAC usando o campo vazio, e responder com pairingId real/prepare autenticados. Nunca permitir campo vazio em outras fases. A resposta usa pairingId real no MAC; R/TH/nonce ligam a consulta à mesma transação.

P pending mas Gestão reiniciou **antes de salvar R/prepare**: não há recuperação automática ou promessa de sucesso; Player mantém slot bloqueado e exige abortar/revogar localmente e novo consentimento/código. Não inventar trust via ID público. Após prepared de ambos, R salva recupera receipts sem código. Se o Player reiniciou e não retém confirmação volátil necessária a um controller-bind duplicado, responder RESULT_UNCERTAIN e exigir status autenticado com R; não devolver token só por IDs/igualdade de requestHash. A resolução retorna o prepare original e preserva a mesma intenção/credencial, sem repetir AKE. Não existe certeza simultânea após ACK perdido; P active já tem prova de estado durável C, mas C pode continuar uncertain até consulta. Retenção de pending não expira silenciosamente.

Revogação local: fence RAM imediato → tombstone/geração incrementada durável → sucesso e fechamento de canais. Falha/resultado incerto mantém bloqueio em RAM e recuperação por releitura; não afirmar revogação permanente antes de persistir. Revogado nunca devolve token/active via recovery; R cifrada pode ser retida só para responder tombstone autenticado. Remover vínculo apenas na Gestão não prova revogação no Player. baseCRevision refere-se ao registro de autoridade do Player selecionado; basePRevision à autoridade única do Player. A Gestão salva registros separados por Player no mesmo store; storeRevision protege o envelope inteiro, sem misturar revisões de autoridades. Um writer verificável por perfil e CAS; não alegar proteção contra administrador que apaga/rollbacka perfil/cofre ou clona computador.

## 8. Lockout e renovação — propostas finais para aprovação

**Lockout:** adotar §12.4: mesmo arquivo G2 de autoridade planejado com FS/cofre existentes, sem DB/serviço adicional. Máximo3 falhas por sessão e5 falhas/reservas em10min, reservas duráveis antes de liberar worker/KE2; duplicates não contam duas vezes. Aplicar também no Main Gestão para impedir tentativas automáticas contra Players falsos. Sucesso remove só própria reserva; KE3 ausente/cancel/timeout após admissão permanece cobrado conservadoramente. Quotas G1 continuam antes de parsing/custo. Store falhou → sem admissão, não fallback vazio.

Sobreviventes de restart recebem cooldown conservador600s desde boot monotônico, sem RTC autorizar liberação. Processo aberto10min permite expiração com gravação confirmada; desligar/reiniciar pode alongar espera, não apagá-la. Recuperação local nunca é “zerar tentativas e autorizar”: preserva evidência, revoga autoridade se irrecuperável, mantém cooldown e exige novo consentimento. Cópia/rollback malicioso por admin do SO está fora da garantia local. storeRevision não altera base authorityRevision autenticada.

**Renovação:** adotar §12.5 stage-first: ação local, gerar/cifrar/validar novo bundle e guardar journal/bundle antigo recuperável antes de revogar. Em um commit de autoridade unir tombstone antigo+geração+promoting; depois promover identidade por replace/readback e voltar deny-all para pareamento guiado. Antes de tombstone, falha preserva identidade antiga válida; depois, só recuperar/promover bundle staged por fingerprint, nunca reativar bearer antigo. Expirado nunca entra em canal operacional; recuperação é local. Journal é lido antes de listener em restart. Playback/local/SQLite/história independentes; não criar rotação automática ou dupla autoridade. Falha/cofre/disco/cert diferente inesperado mantém remoto bloqueado e material recuperável preservado.

## 9. Aceites, riscos e plano Luna

Riscos aceitos para decisão: wrapper/core tem auditorias históricas, não uma auditoria integral nova do release/perfil; não foi reproduzido AKE integral RFC pela API pública (KSF/context/RNG diferentes), embora haja vetores oficiais parciais, revisão do source/proveniência, negativos reais e prova funcional Node/Electron/ASAR. Não há vulnerabilidade grave conhecida demonstrada no caminho selecionado. Não alegar tempo constante universal WASM/CPU nem proteção a endpoint comprometido/código observado. Nenhum pacote PAKE alternativo avaliado entrega vantagem de evidência suficiente para compensar nova superfície agora.

A prova adicional final exercita perfil/binários/CTX/provas/MACs reais em dois processos, alterações de código/cert/nonce/geração, confirmações divergentes, replay, cancelamento/reset e modelo de admissão concorrente. Vetores de KDF/MAC de aplicação são exportados como fixtures públicas e conferidos independentemente com Python cryptography. Teste anterior de MITM TLS real e empacotamento/worker não será repetido sem mudança relevante. Modelos não comprovam o coordinator/store futuro.

G2.2 após aprovação: fixar pacote/integrity; implementar schemas exatos/ports, worker/provider encapsulado e guardas; coordinator/consentimento, budget durável, B2 store/receipts/recovery, revogação e stage-first; compor G1 sem ciclo nem bypass. Nenhuma decisão de PAKE/KDF/encoding deve ser criada pelo implementador. Não implementar UI G5/controles H/reconexão automática G4.

G2.3: testes reais de store/CAS/locks, crash em cada escrita/receipt, cofre/corrupção/disco cheio, races cancel/revoke/deadline/worker, credenciais ausentes/revogadas, duas Gestões, status pending com primeira resposta perdida, reset entre etapas, parsing/bounds/IPC e zero dispatch antigo; Electron/ASAR/Windows oficial e consumo de memória sob hardware suportado antes de ativação de produção. Incluir especificamente KE3 antigo concorrendo com novo ake-start e recovery bound com prepare perdido antes de conhecer pairingId. Native Windows/LAN física ficam validações posteriores conforme autorização; não transformar em investigação arquitetural indefinida. Full AKE differential/fuzz são defesa adicional desejável, não declaração fictícia de PASS.

Produto só habilita com apresentação segura G5 aprovada, checks automatizados aplicáveis da implementação PASS e autorização do proprietário. Aprovar arquitetura não homologa G1 em todas as plataformas nem G2/H operacionalmente.

**PROTOCOL DECISION: OPAQUE-3DH / @serenity-kit/opaque@1.1.0 / kq-pair/2. SECURITY ASSESSMENT: APTA PARA APROVAÇÃO arquitetural, com trade-offs acima. G2.1 READY FOR OWNER DECISION: SIM. G2.2/G2.3: NÃO INICIADAS. PROPRIETÁRIO: AGUARDANDO DECISÃO.**

Verificação da proposta: revisão Sol somente leitura considerou a escolha defensável e apontou ajustes de T persistido/userIdentifier/enum, incorporados. Testes do perfil alinhado passaram em Node24.15 e Electron45/Node24.22 com dois processos; Python confirmou CTX/T/KDF/MACs, e os cinco receipts/recovery bound com prepare perdido foram conferidos entre linguagens. Timeout/cancel/concorrência permanecem modelos delimitados; nenhum PASS de coordinator/store/UI/Windows foi inferido. Sintaxe, links locais/JSON/whitespace e git diff --check PASS; só documentação e harnesses de validação, produção intacta.
