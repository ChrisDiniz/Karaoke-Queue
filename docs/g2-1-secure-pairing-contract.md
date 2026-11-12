# G2.1 — Análise e contrato candidato de pareamento seguro

Data: 2026-11-12. **Estado vigente: decisão arquitetural final OPAQUE1.1.0 / kq-pair/2, APTA PARA APROVAÇÃO proporcional pelo proprietário. [Perfil implementável](g2-1-final-pairing-profile.md). Seções 1–13 preservam a investigação histórica e seus bloqueios; seção14 os substitui como recomendação atual.** Contrato `kq-pair/1` na seção 11 substitui as escolhas abertas do draft. Seções 1–10 preservam o histórico da análise documental anterior. Produção continua bloqueada. [Ticket G2](backlog/0007-fase-g-comunicacao-remota-segura/0002-g2-pareamento-dispositivos.md). Prevalece o [complemento T1 LAN](g1-1-t1-lan-pairing.md). Não autoriza G2.2/G2.3.

## 1. Escopo, evidência e parecer

Base inspecionada: `75af81822fdc929ea5c011ad6a5efa73bfcf24c2`. Working tree inicialmente limpa, branch `feature/remote-player-lan-integration-3`. Consultados AGENTS, roadmap, backlog, T1/proposta LAN, auditoria G1, contrato/plano/UI pareados e arquitetura remota; inspecionados contratos, clientes, TLS, transporte, identidade, cofre e composição Main da G1. O aceite G1 com limitações está registrado no início da auditoria; não equivale a homologação integral. Windows, rebuild limpo e LAN física continuam com as limitações documentadas. Não reabrir G1 por isso.

**SRP + binding: REVISÃO NECESSÁRIA.** A inspeção não sustenta liberação criptográfica: fonte upstream mutável não equivale ao artefato publicado fixado; vetores/interoperabilidade, execução Electron e revisão independente ainda faltam. Há diferenças de perfil e riscos de implementação concretos abaixo. Os contratos de lifecycle/persistência estão propostos; os criptográficos permanecem candidatos, portanto o handoff executável ao Luna está **PENDENTE**. Nenhum implementador deve preencher esses gates por julgamento próprio.

## 2. Biblioteca e alternativas

Fontes primárias consultadas online nesta rodada:

- [Fonte SRP upstream](https://raw.githubusercontent.com/homebridge/fast-srp/master/src/srp.ts): usa crypto/Buffer e jsbn incorporado, exponenciação síncrona; valida A/B no intervalo 1..N−1. Não há teste explícito de u=0 nos caminhos setA/setB consultados. A função equal compara strings hex com `===`, apesar do comentário sobre tempo constante; o próprio comentário reconhece modexp sem tempo constante. API permite computeK antes da autenticação. Existem overloads de prova distintos: preservar identidade/salt e modo HAP; não usar construtor apenas com verifier. São riscos de integração, não demonstração de exploração remota.
- [Parâmetros](https://raw.githubusercontent.com/homebridge/fast-srp/master/src/params.ts): **params[3072] usa SHA-256; params.hap usa SHA-512**, N de 3072 bits e g=5. Fixar `hap`; nunca selecionar só pelo tamanho.
- [Manifest upstream](https://github.com/homebridge/fast-srp/blob/master/package.json): declara versão 2.0.4, entrada CommonJS, Node >=10.17, MIT e nenhuma dependência runtime declarada; jsbn é distribuído dentro do pacote. Isso sugere compatibilidade com o CommonJS/Electron 45 do projeto, não comprova execução. [Licença](https://raw.githubusercontent.com/homebridge/fast-srp/master/LICENSE): manter notices também do código incorporado, conferir tarball.
- [RFC 5054](https://www.rfc-editor.org/rfc/rfc5054): valores públicos e parâmetros exigem validação; segredos efêmeros devem ter pelo menos 256 bits. Seus vetores SHA-1/1024 não certificam diretamente o perfil HAP/SHA-512. Não adotar suas antigas cipher suites TLS; aqui SRP é de aplicação sobre TLS G1.

Candidato a qualificar: `fast-srp-hap@2.0.4`, **não aprovado nem instalado**. Antes de fixar: confrontar tarball/integrity e commit imutável com a fonte, licença jsbn, histórico de releases, advisories e política de suporte. Não foi estabelecida auditoria independente, ausência de CVEs ou cadência de manutenção suficiente. Acessos raw inicialmente falharam; os links acima foram acessados depois, mas não houve download/execução do artefato publicado. Não afirmar pacote auditado ou interop PASS.

Bloqueios B1: artefato/perfil/provas/vetores independentes não qualificados; B2: composição abaixo sem análise independente/vetores ativos; B3: tempo variável e u=0 exigem decisão de segurança ou biblioteca mantida que os trate. Não corrigir matemática em fork local. Não basta trocar equal no adapter e declarar toda biblioteca constante. CPU síncrona pode bloquear Main: antes de produção medir latência/event-loop no Electron Windows/Linux sob carga; preferir worker Main-owned isolado para provider se necessário, com cancelamento por geração e teto de um trabalho ativo. Isso não é renderer com Node.

Se B1–B3 não forem resolvidos, manter bloqueado e avaliar **SPAKE2 conforme [RFC 9382](https://www.rfc-editor.org/rfc/rfc9382)**, com implementação existente qualificada e confirmação/contexto do protocolo, não uma implementação própria. É alternativa verificável de especificação, não biblioteca já escolhida/aprovada. Preserva código/consentimento/LAN; exige nova revisão de adapter, vetores, licença e binding. Não trocar PAKE silenciosamente nem usar TOFU/código bearer.

## 3. Contrato criptográfico candidato (não normativo para produção)

Gestão = cliente SRP, Player = servidor. Sem negociação de grupo/hash: versão exata `kq-pair/1-draft.1`, perfil `srp6a-hap-3072-sha512`. Versão desconhecida falha fechada, sem fallback. Senha SRP = oito bytes ASCII dos oito dígitos, incluindo zeros iniciais. I = ASCII `KQ-Pair-v1:` seguido do sessionId hexadecimal minúsculo de 32 bytes aleatórios. Salt, a e b frescos de 32 bytes CSPRNG por tentativa; rejeitar segredo zero antes de chamar provider. Provider deve oferecer M1/M2 HAP e K de 64 bytes, sem expor S/x/verifier. Verificar comprimentos e 0<A,B<N antes do provider; solução para u=0 é gate B3.

Encoding autenticado E: sequência de campos, cada campo `uint32be(comprimento em bytes) || bytes`, sem objeto JSON/ordenação dinâmica. Strings ASCII; UUIDs canônicos minúsculos; inteiros decimais ASCII sem zeros iniciais (exceto 0); binários crus dentro de E. HTTP usa JSON estrito, chaves exatas por mensagem, UTF-8 fatal, sem chaves duplicadas; binários base64url sem padding e reencoding idêntico. IDs de sessão/operação/nonce: 32 bytes, fingerprint: SHA-256 DER 32 bytes, salt:32, A/B:384, M1/M2:64, MAC:32. Rejeitar qualquer outra largura, tipo, campo extra, URL, profundidade ou corpo >16 KiB. Não usar floats, nomes ou PEM como identidade autenticada.

T = E, nesta ordem: domínio `KQ-Pair-transcript`, versão, perfil, finalidade `initial|renewal`, sessionId, operationId inicial, attemptId, nonceC, nonceP, controllerId, playerId, papel `controller`, papel `player`, fingerprint DER observado pela Gestão, fingerprint local do Player, serverName, expectedCredentialGeneration, targetCredentialGeneration, autorização revision esperada, salt, A, B, validade em segundos `120`, escopos solicitados serializados em ordem ASCII e sem duplicatas. Para G2, escopos operacionais vazios. Ambos calculam localmente T; não aceitar um hash de transcript pronto fornecido pelo peer.

Após Player verificar M1 e Gestão verificar M2, derivar por [HKDF RFC 5869](https://www.rfc-editor.org/rfc/rfc5869): `TH=SHA256(T)`; HKDF-SHA256 com IKM=K, salt=TH, info=E(`KQ-Pair-v1`, rótulo), L=32, para rótulos separados `bind-player`, `bind-controller`, `recovery`, `commit-player`, `commit-controller`. HMAC-SHA256 e timingSafeEqual com comprimento fixo nas confirmações. Player envia `HMAC(kBindP,E('player-bind',TH,M1,M2))`; Gestão verifica certificado/contexto e envia `HMAC(kBindC,E('controller-bind',TH,M1,M2,playerBind))`. Player verifica antes de preparar credencial. Nunca emitir dados cifrados/verificáveis derivados de K antes de M1 válido. Não registrar K, provas, verifier ou código. O uso de primitivas padronizadas não transforma esta composição em protocolo padronizado/auditado.

### Binding e ameaça MITM

G1 `probeBootstrapCertificate` obtém DER sem confiança de cadeia, sem HTTP, valida formato/validade/SAN; resultado é somente candidato. `createBootstrapChannel` fixa esse certificado como âncora temporária, sem Authorization, redirects ou acesso a /control. Cada nova conexão deve usar o mesmo pin; substituição após probe falha TLS. Player calcula fingerprint do certificado **local da conexão TLS** (getCertificate/raw ou identidade validada equivalente amarrada ao listener); Gestão usa DER realmente observado/validado no canal, nunca o TXT mDNS ou campo remoto.

Antes do bind, exigir igualdade dos dois fingerprints, SAN/playerId e geração esperada. MITM que termina TLS com certificado próprio pode retransmitir SRP, mas os dois T diferem e não consegue forjar MAC sem K. Se copiar certificado sem chave, não termina TLS; relay TCP ao certificado real não o transforma em outro peer. Credencial só circula após confirmação bilateral; nenhuma confiança parcial persiste durante SRP. Ausência de mTLS é intencional: controllerId isolado não autentica Gestão; posse do código na sessão consentida e depois bearer individual são a autoridade. Computador comprometido/observador local do código estão fora da proteção PAKE.

## 4. Código, consentimento e quotas

Fluxo preservado: descoberta automática; Dispositivos à esquerda do sino; selecionar Player; consentimento local; exibir oito dígitos; digitar na Gestão; verificar/persistir; conectar aguardando reconciliação. Sem arquivos, QR, fingerprint ou IP no caminho principal. G5 implementa visuais aprovados posteriormente.

Gerar `crypto.randomInt(0,100000000)` e padStart(8,'0'), uniforme sem módulo enviesado. Apresentar 4–4; remover somente separador visual previsto no input, exigir oito dígitos ASCII. Exibir só janela local do operador, nunca superfície de vídeo/TV ou notificações espelhadas; G5 precisa comprovar esse isolamento. Observação física do código permite ataque online na sessão: não prometer proteção contra ela. Sem clipboard automático/telemetria/log/mDNS/dump intencional.

Uma reserva serializada global por Player, não por IP. Espera de consentimento no máximo 120 s; código vence 120 s após aceitar, por relógio monotônico; nenhum polling renova deadline. Até três tentativas incorretas na sessão: cada tentativa usa novo attemptId, salt, a/b e provas; código permanece até término da sessão. Após cada erro destruir todo estado SRP anterior, sem reusar A/B. Terceira falha encerra e exige novo consentimento/código. Falha de bind encerra imediatamente. Reserva/contador incrementado antes de trabalho caro; duplicata idêntica não conta novamente, payload conflitante encerra. No máximo cinco falhas globais numa janela móvel de dez minutos, independente de IP/ID alegado; quinta falha bloqueia admissões até sair da janela. Quota G1 não substitui esta. Proposta: persistir timestamps/lockout sem segredos; relógio regressivo gera lockout conservador de dez minutos, falha de armazenamento bloqueia bootstrap. Decisão adicional a aprovar, pois T1 só garantia contador em memória + novo consentimento no restart.

Cancelamento, timeout, rejeição, socket perdido antes de commit e restart destroem código/verifier/segredos, invalidam generation token e fecham apresentação. Limpeza de buffers é best-effort: GC/strings JS não oferecem apagamento garantido. Após iniciar persistência, falha de comunicação vira resultado incerto, nunca “cancelado” com rollback presumido.

## 5. Estados, envelopes e interfaces

| Estado Player | Entrada admitida | Saída/efeito |
|---|---|---|
| idle-unbound | request novo | reserve → awaiting-local-consent |
| awaiting-local-consent | aceitar/rejeitar local, cancel, deadline | code-ready ou terminal |
| code-ready | start-attempt | verifying-srp; demais Controllers busy |
| verifying-srp | M1 válido/erro | awaiting-controller-bind ou nova tentativa dentro das quotas |
| awaiting-controller-bind | bindC válido | preparing; sem autorização ainda |
| preparing | journal confirmado | prepared; erro storage → uncertain/blocked |
| prepared | receipt Gestão durável | committed; sem operação de negócio |
| committed | receipt final Gestão | paired; retorno perdido consultável |
| paired | recuperação autenticada/revogação local | mantém vínculo ou revoked |
| uncertain/blocked | consulta autenticada/releitura/local recovery | nunca novo vínculo automático |

Terminais pré-commit: rejected, cancelled, timed-out, error; limpam estado efêmero. Gestão espelha discovering → selected → requested → waiting-consent → awaiting-code → verifying → binding → saving → awaiting-peer-commit → paired-awaiting-reconciliation, ou terminais/uncertain. Link, vínculo e modo operacional são eixos independentes.

Envelope JSON candidato: `{version,type,sessionId,operationId,attemptId,payload}`. Campos não aplicáveis têm ausência definida por schema, nunca null implícito. Tipos por rotas G1: `/request`: open/poll/cancel; `/proof`: start-attempt/client-proof; `/confirm`: controller-bind/prepare-receipt/commit-receipt/status. open usa operationId/nonceC/controllerId/nome limitado/finalidade/revisões esperadas; response fornece sessionId/nonceP/playerId e estado. Salt/B só após consentimento e start-attempt; client-proof leva A/M1; resposta M2/playerBind. Poll/cancel pré-autenticação requer capacidade aleatória de sessão de 32 bytes devolvida no open, só para observar/cancelar aquele pedido, nunca para autorizar/obter código. Status pós-restart exige recovery MAC, não sessionId público. Nenhum endpoint devolve o código.

Erros fechados: BUSY, ALREADY_BOUND, REJECTED, EXPIRED, RATE_LIMITED, INVALID_MESSAGE, AUTH_FAILED, REVISION_CONFLICT, STORAGE_UNAVAILABLE, RESULT_UNCERTAIN; sem diferenciar detalhes de prova inválida ao peer. HTTP 400/403/409/410/429/503 conforme categoria; respostas de sucesso 200/202, sem redirects. Congelar schemas completos e vetores byte a byte antes de implementação: este inventário não substitui schemas executáveis aprovados.

Ports propostos (Main-only): PairingCoordinator open/poll/startAttempt/prove/confirm/status/cancel, todos com AbortSignal; LocalPairingPresentationPort showRequest/showCode/clear/publishStatus e callbacks accept/reject vinculados a sessionId+revision; PairingCryptoPort inicia cliente/servidor, verifica provas, confirma binding e dispose; PairingStore load/compareAndPersist(expectedRevision,candidate)/recover; Clock monotonic/wall e RNG injetáveis. Renderer só recebe view-model mínimo e código temporário na janela Player autorizada; Gestão envia input por IPC restrito. Sem K/token/chave privada/certificados/raw socket/URL genérica no Renderer. Validar sender, frame, papel, revisão e consentimento no Main; fixture não é consentimento de produção.

## 6. Persistência bilateral, recuperação e revogação

Não existe commit atômico distribuído entre dois PCs nem certeza simultânea sob perda arbitrária. Exigir evidência durável dos dois lados antes de declarar sucesso; um lado pode ficar incerto enquanto o outro já tem essa evidência. Nunca substituir isso por sucesso otimista.

Um arquivo de autoridade por perfil, schemaVersion=1, revision monotônica safe integer, credentialGeneration monotônica distinta de controlEpoch e de SemVer; um slot por Player com pairingId, controllerId/playerId, pin/cert, transcriptHash, estado pending/committed/active/revoked, operationId e receipts. Gestão pode armazenar registros por Player; Player só um Controller. Secrets cifrados via SecretProtector; bearer CSPRNG de 32 bytes base64url (43 chars, compatível G1); Player guarda hash para comparação e envelope cifrado para retransmissão idempotente. recoveryKey cifrada separada, nunca aceito como bearer operacional. Nenhum verifier/código/K SRP durável.

Ordem candidata, somente após binding:

1. Player gera bearer e pairingId, grava **pending** com recoveryKey, token cifrado/hash e geração alvo usando CAS; fsync/replace/readback. Ainda deny-all. Devolve prepare autenticado com pin/IDs/geração/pairingId/token via canal TLS já bound e MAC de commit cobrindo todo payload (E com campos fixos).
2. Gestão verifica, cifra e grava **prepared** durável com os mesmos valores. Só então envia prepare-receipt autenticado com chave commit-controller e hash do prepare.
3. Player verifica receipt/revisão, grava **committed** com receipt Gestão; responde commit-receipt autenticado. Não anuncia sucesso antes dessa gravação.
4. Gestão grava **committed** com receipt Player; envia final receipt. Player grava active com final receipt. Resposta final permite Gestão publicar paired; perda mantém Gestão uncertain, consulta pelo pairingId/operationId original recupera resultado. Controle continua bloqueado até G4/H.

Receipts/recovery usam mensagens tipadas, E, nonce fresco de consulta/resposta e MAC cobrindo versão, direção, pairingId, operação, geração, revisão, estado e digest do registro; chaves commit persistidas somente para resolver transação, ou rederivadas de recoveryKey com HKDF/rótulos próprios. **Escolha exata entre essas duas opções e schemas de receipt é pendência B2, não tarefa para improvisar no Luna.** Replay não pode retroceder estado/revisão. Não existe novo bearer a cada retry. Token do pending não passa authorizeBearer. Status só recupera aquela transação; não abre pareamento novo.

Crash antes de pending: novo consentimento. Crash depois de pending: startup carrega fail-closed antes da rede; Gestão sem prepare persistido não autentica recuperação e precisa cancelamento/recovery local no Player. Após prepared em ambos: recovery autenticado recupera receipts sem código; queda não apaga vínculo. Pending não expira silenciosamente nem libera slot para outro Controller após deadline do código; requer resolver ou abortar localmente com tombstone durável. Cancel após prepare retorna incerto até resolução durável. Disco cheio, corrupção, decrypt/re-encrypt ou rename/readback incertos bloqueiam autorização, preservam arquivos e pedem recuperação local. Não regenerar identidade nem restaurar backup autorizado automaticamente.

Arquivo: temp exclusivo no mesmo diretório, permissões restritas, flush arquivo, replace e flush diretório onde suportado, readback/validação antes de publicar. G1 helper privado não é API de store nem prova de durabilidade Windows em power loss. Serializar toda mutação/auth/revoke; CAS em memória sozinho não protege outro processo: exigir exclusão de writer do mesmo perfil por lock verificável e teste interprocessos, falhando fechado se indisponível. Não presumir exclusividade entre perfis/contas. Rollback malicioso de arquivos/cofre por usuário do SO está fora da garantia local; documentar limite, não prometer contador monotônico inviolável.

Revogar exige ação local explícita no Player, esperada geração/revisão; fence RAM imediato, persistir tombstone e geração incrementada, depois sucesso e fechamento de canais. Falha de gravação: permanece bloqueado no processo, não declarar revogação persistente nem liberar novo vínculo; recovery local. authorizeBearer e isCurrent revalidam estado ativo/ID/geração após awaits; callbacks antigos nunca reativam peer. Remote request não substitui nem revoga vínculo. Remover credencial só na Gestão não é prova de revogação no Player.

## 7. Casos especiais e G1

| Caso | Regra/incompatibilidade mínima |
|---|---|
| Duas Gestões | Reserva/CAS única; segunda busy; nenhuma troca de código ou expulsão |
| Pedido durante reprodução | Sem pause/stop/fila. Consentimento via presentation port; se superfície local segura indisponível, rejeitar temporariamente |
| Player já vinculado | ALREADY_BOUND; somente revogação local explícita pode liberar outro Controller |
| Cert expirado | G1 loadOrCreatePlayerIdentity e probe rejeitam; listener não inicia. **Recovery anual não está pronto** |
| Renovação anual | Ação local cria certificado candidato válido antes do bootstrap; nunca aceitar expirado. Fence/revogação durável do anterior antes de promover identidade nova; interrupção conserva journal de renovação e modo remoto bloqueado. Repetir consentimento/código, pin e geração novos. Exige contrato de store de identidade com staging/recovery, ausente G1 |
| Troca de computador/perfil | Novo principal; sem copiar cofre/trust ou inferir pelo nome; revogar no Player, novo consentimento |
| Queda/restart | Vínculo permanece; tentativa de status por intenção original, sem controle; reconexão automática só G4, respeitando offline explícito |
| Cofre indisponível | Sem pairing/autoridade; playback local preservado |

Reuso: RemoteBootstrapPort, RemoteAuthorizationPort, probeBootstrapCertificate, createBootstrapChannel, clientes HTTPS/WSS pinados, SecretProtector, identidade e discovery. Bootstrap servidor já aceita só três POSTs sem Authorization/Cookie/Origin e corpo limitado; G2 multiplexa subtipos sem novas rotas operacionais. connectionId bootstrap é randomUUID **por request**, não identidade de sessão: usar sessionId/operationId e proofs; não amarrar sessão ao connectionId. Context.socket é tipado Socket embora seja TLSSocket; adicionar port restrito de informação TLS local/cancelamento em vez de passar socket ao domínio. AbortSignal/deadline do handler não é fornecido: precisa adapter mínimo para desconexão/shutdown, fencing e timeout; não aguardar consentimento dentro dos 10 s HTTP, usar 202/poll limitado.

MainRemoteRuntime expõe startPlayer e discovery, mas não loader de identidade Gestão ao consumidor nem PairingCoordinator/store. Acrescentar composição G2 no Main, com G1 importando apenas ports, sem G1→G2. Carregar autorização antes do listener; sem presentation port de produção aprovado manter bootstrap desabilitado. Rotas operacionais continuam ausentes/deny-all; G2 não implementa H. Mesmo peer autenticado não recebe escopo playback/fila nesta etapa. Renovação é extensão mínima necessária do adapter de identidade, não enfraquecimento da validação TLS.

## 8. Plano futuro Luna e gates

G2.2 somente após aprovação: (A) schemas/ports/provider fixado e fixtures criptográficas aprovadas; (B) coordinator/presentation fixture/quota e estados sem runtime habilitado; (C) store/CAS/receipts/recovery/revogação e adapter RemoteAuthorizationPort; (D) bootstrap/runtime e staging de renovação, com testes de fronteira. Arquivos propostos: remote-pairing-contracts, remote-pairing, remote-pairing-store e provider; mudanças mínimas em remote-contracts/clients/identity-store/main-remote-runtime. Confirmar nomes reais antes de criar; não criar biblioteca criptográfica própria. Sem UI G5 ou integração H, sem banco operacional.

G2.3: executar matriz abaixo, revisar segurança/diff/empacotamento e registrar evidências. Não marcar fase aprovada por PASS técnico. Production enable permanece falso até consentimento real G5 aprovado, todos os gates de segurança PASS e autorização explícita do proprietário. Fixtures podem dirigir consentimento apenas em testes isolados; nenhum flag/env/bypass remoto liberando produto.

| Gate | Cenários obrigatórios/oráculo | Ambiente |
|---|---|---|
| CRYPTO | Vetores conhecidos da biblioteca e implementação independente no perfil HAP, M1/M2/K e transcript/HKDF/MAC byte a byte; zeros/larguras/u=0/parâmetros inválidos | SRP real, nunca mock; Node e Electron fixados |
| MITM | Relay entre dois certificados, troca após probe, manipular cada campo T, versões/reflection/prova truncada/M2 ausente/replay | Dois peers TLS reais + proxy adversarial; zero trust/bearer antes de bind |
| CONSENT | Nenhum código antes de aceitar; três falhas/120 s/cinco em dez minutos; duplicatas e concorrência, cancel/timeout/restart/clock rollback | Clock/RNG/barreiras; nenhum sleep arbitrário |
| DURABLE | Crash em cada write/sync/replace/readback/receipt; resposta perdida; pending vs active; duas operações conflitantes; disco cheio/corrupto/cofre negado | FS isolado real + injeção; dois processos/perfis |
| REVOKE | authorize aguardando × revogar; WS antigo; restart/tombstone; nova geração; callback antigo | Barreiras e HTTPS/WSS reais; nenhum dispatch antigo |
| RENEW | 30/7 dias como dados de apresentação, expirado, crash staging/promoção, pin novo/antigo, troca de perfil | Identidades independentes/relógio; sem certificado vencido aceito |
| BOUNDARY | Sender/frame errado, segredos ausentes do Renderer/log/mDNS, bootstrap sem acesso operacional, produção sem presentation port | IPC/Electron real; fixture explicitamente de teste |
| PLATFORM | CJS/provider/worker/CPU, cofre real, ASAR/dependências/notices e restart | Electron Linux/Windows, CI Windows existente/runner oficial NTFS |
| PRODUCT | Consentimento local real/código fora da TV e comparação Doop; offline respeitado | G5/G4/H autorizadas; dois computadores físicos somente G6/H5 |

CRYPTO/MITM/CONSENT/DURABLE/REVOKE/RENEW/BOUNDARY/PLATFORM e consentimento real são bloqueadores de ativação. Mocks cobrem estados/falhas, não alegações SRP. Dois processos loopback não homologam LAN física. Reutilizar pr-validation.yml, sem disparar publicação. Runner Windows continua com bloqueio de heurística G1 documentado, não contornar. Nesta rodada testes criptográficos/aplicação/compile/Electron/Windows **NOT RUN**: escopo documental, sem dependência instalada/implementação; nenhuma evidência G1 foi reatribuída à G2.

## 9. Decisões para revisão e proprietário

Antes do Luna: fixar artefato imutável e validar B1/B3; revisar composição B2 e congelar schemas/receipts/derivação recovery; aprovar lockout persistente e journal de renovação/autoridade; executar vetores e revisão criptográfica independente. Estes são bloqueios explícitos, não decisões delegadas implicitamente à implementação. Revisão Sol deve avaliar especialmente proofs HAP, side-channels e impossibilidade de commit simultâneo; aprovação do proprietário segue separada. A revisão independente documental do Sol foi realizada nesta rodada, conforme registro abaixo; não equivale à qualificação criptográfica pendente.

**G2.1: BLOQUEADA para aprovação técnica**, com proposta documental entregue. **Protocolo SRP + binding TLS: REVISÃO NECESSÁRIA. Contratos G2.2/G2.3: PENDENTES. Aprovação do proprietário: AGUARDANDO. Implementação G2: NÃO INICIADA.** Não avançar automaticamente.

## 10. Revisão independente Sol e verificação documental

Sol revisou este documento e os contratos G1 em modo somente leitura. Recomendou manter BLOQUEADA/REVISÃO NECESSÁRIA/PENDENTES. Não identificou quebra grave demonstrável do binding sob as hipóteses do PAKE; considerou coerente pending sem autoridade e resultado incerto. Não executou testes nem declarou PASS criptográfico.

Ressalva adicional B2: chaves commit inicialmente derivadas de K **não podem ser reconstruídas presumindo nova derivação de recoveryKey**. Ou persistir as chaves originais cifradas, ou redefinir toda a árvore de derivação inicial/recuperação coerentemente e revisar vetores. Essa escolha deve ser fechada na revisão G2.1, antes do Luna. Também congelar digest/receipts/revisões dos dois lados, resposta final comprovando active e idempotência. B1/B3 e staging de renovação permanecem bloqueios. Revisão documental não substitui auditoria criptográfica especializada nem aprovação do proprietário.

Verificação desta rodada: links relativos dos documentos G2 e whitespace PASS; `git diff --check` PASS. Somente três documentos modificados/criados (esta proposta, ticket G2 e checkpoint do roadmap). Testes de aplicação/criptografia não executados; nenhuma dependência instalada ou código alterado.

## 11. Retomada executável — contrato fechado proposto `kq-pair/1`

Esta seção substitui as opções em aberto das seções 3/5/6 **como proposta de bytes**, sem liberar produção. O histórico anterior permanece evidência da primeira análise. Autorização desta rodada: testes isolados e documentação, não G2.2/G2.3. As três alterações documentais anteriores já existiam na working tree e foram preservadas.

### 11.1 Resultado dos bloqueios

| Bloqueio | Resultado | Alcance |
|---|---|---|
| B1 | PASS para identificação/reprodutibilidade e funcionalidade nos vetores executados | Não significa adequação irrestrita a produção; limitações de interop/padding e B3 abaixo |
| B2 | PASS para contrato proposto e experiências de composição | Árvore/receipts/recovery escolhidos; não é auditoria criptográfica nem teste da implementação futura |
| B3 | BLOCKED | Provider continua com comparações/exponenciação variáveis; não há mitigação verificada que permita aprovar sua segurança de produção neste parecer |

Parecer: manter a experiência SRP/código/TLS como direção, mas **não recomendar fast-srp-hap@2.0.4 em produção neste estado**. Não houve ataque de recuperação de senha demonstrado; não confundir risco não encerrado com vulnerabilidade explorada. Não substituir protocolo automaticamente. O contrato pode orientar revisão e futura implementação, mas não deve ser entregue ao Luna como liberado enquanto B3 persistir.

### 11.2 Artefatos, origem e licenças

Baixados diretamente via HTTPS do registry npm, sem executar lifecycle scripts nem instalar dependências no projeto:

- `fast-srp-hap@2.0.4`, tarball `https://registry.npmjs.org/fast-srp-hap/-/fast-srp-hap-2.0.4.tgz`.
- Integrity SHA-512 conferida: `sha512-lHRYYaaIbMrhZtsdGTwPN82UbqD9Bv8QfOlKs+Dz6YRnByZifOh93EYmf2iEWFtkOEIqR2IK8cFD0UN5wLIWBQ==`.
- SHA-256 do tarball: `41356e01728c9b4f1d92d7468e97cc9564d3157d126a6f425460536fd4e6f8b9`.
- `gitHead=df6cdb6583024a3e4379501f4689777f02aa4d8c`. srp.js/params.js publicados coincidiram byte a byte (excluído somente sourceMappingURL) com emit do TypeScript 4.4.3 sobre esse commit. jsbn.js e LICENSE também coincidiram. Emit não é alegação de typecheck do pacote histórico com o ambiente atual.
- Manifest sem dependências runtime; jsbn incorporado, com aviso permissivo de Tom Wu no próprio arquivo; LICENSE MIT do pacote. Não basta olhar dependencies para inventariar código incorporado.
- Registry registra publicação 2.0.4 em 2021-10-07. Nenhuma conclusão de manutenção ativa é derivada de downloads/popularidade. Consulta web de advisories GitHub não retornou conteúdo verificável; **ausência de vulnerabilidades conhecidas não foi atestada**. Integridade confere com metadata obtida no mesmo registry; assinatura npm não foi validada contra uma raiz independente.

Referências independentes: [HAP-python hsrp no commit 13569343833e67547366ef3f5db183c47ba7baab](https://github.com/ikalchev/HAP-python/blob/13569343833e67547366ef3f5db183c47ba7baab/pyhap/hsrp.py), SHA-256 `eb2c90235ae00169803a88a4d12a9516ec5a7e7216eb8a905867e2635903e53b`; [pysrp no commit 2f0211d7965290664af1537a0164dbb82a7270ff](https://github.com/cocagne/pysrp/blob/2f0211d7965290664af1537a0164dbb82a7270ff/srp/_pysrp.py), SHA-256 `574a00066d8023a34291c504dcf9a3ca24dd8f8aef1ac6623416403c2b9c6064`. Código SRP externo carregado sem alterar fórmulas; shim de HAP-python fornece apenas conversão int→bytes, evitando dependências utilitárias alheias. Não qualifica essas bibliotecas para produção. Pysrp tem diferença na prova HAP (padding de g); só S/K foram usados como oráculo nele. HAP-python confirmou B/S/K/M1/M2 no vetor fixo, mas pode divergir em zeros iniciais de S/K: não alegar interop universal.

Os vetores HAP upstream são uma fonte conhecida, não independente; por isso foram confrontados com essas outras implementações. O vetor RFC5054 foi obtido como referência, mas não executado como suíte: ele usa SHA-1/1024, não o perfil final. Não criar SRP próprio para obter uma segunda opinião.

### 11.3 B3 — classificação e controles obrigatórios

| Achado | Classificação | Tratamento |
|---|---|---|
| A/B zero, N, >N, oversized e vazio recusados nos testes | Contrato observado | Adapter exige exatamente 384 bytes e intervalo 1<A,B<N antes de provider; representação curta de 2 foi aceita pelo pacote e deve ser recusada pelo adapter |
| Constante interna chamada zero resulta em 1 pelo construtor jsbn | Discrepância reproduzida, sem bypass demonstrado | Guardas do pacote são mais restritivas (rejeitam 1); contrato usa 1<A,B<N, não depende desse detalhe |
| u=0 aceito mediante fault injection SHA-512 | Falta de guarda demonstrada, não ataque real | Adapter calcula somente SHA512(A384 || B384) usando crypto, recusa resultado todo zero antes de setA/setB. Isso é validação pública, não reimplementação de matemática SRP; provar em testes futuros que provider nunca é chamado nesse caso |
| Comparação hex `===` de M1/M2 e modPow variável | Risco plausível sem exploração comprovada; bloqueante neste parecer | Limites/segredos efêmeros reduzem amostras, mas não demonstram segurança contra canal lateral; worker resolve responsividade, não tempo constante. Não fazer fork nem prometer correção com timingSafeEqual só nos MACs externos |
| computeK antes de prova válida | API perigosa, mitigável por encapsulamento | Provider port não exporta K; deriva internamente chaves de binding após M1/M2; só libera persistência/credenciais após bind bilateral; nunca enviar prepare/MAC Player antes de M1 válido |
| Provas públicas indevidas/replay/reflection/downgrade | Negativos executados no escopo descrito | Versão/perfil fixos, papéis separados, novo salt/a/b/attemptId por tentativa e transcript autenticado |
| Código 10^8 possibilidades (~26,6 bits) | Limitação de segredo humano | 3 por sessão/5 globais em 10 min, quota antes do custo, sem verifier persistido, sem código claro. Probabilidade ideal de acerto em cinco palpites ≤5×10^-8; não modela observação física ou canal lateral |
| Exponenciação síncrona ~1 s por troca completa | Limitação de responsividade demonstrada | Um worker Main-owned por processo, uma tentativa ativa e geração cancelável. Não executar SRP no Main; validar worker e desempenho Windows em G2.3 antes de habilitar |

Nenhum desses testes demonstra ataque de dicionário offline viável contra o SRP correto. Roubo de verifier/código, malware local, inspeção de memória e observação do código são riscos diferentes. Quota global deve reservar tentativa atomicamente e não depender do IP; restart não recupera código. Persistir lockout sem segredos conforme §4 permanece proposta adicional para aceite.

Alternativa verificada por inspeção: [python-spake2](https://github.com/warner/python-spake2) é implementação existente MIT/Python com dependência cryptography, útil como referência de experimento; não é substituição Node/Electron direta nem interop RFC9382 demonstrada aqui. Não adicionar processo Python ao produto por arrasto. RFC9382 fornece outra especificação verificável, mas escolher/qualificar provider compatível e revisar contrato é trabalho necessário se SRP for abandonado. Nem trocar algoritmo nem dispensar binding são soluções automáticas para B3.

### 11.4 Árvore de chaves e bytes definitivos da proposta

Manter E, larguras e ordem T da §3, substituindo versão por ASCII `kq-pair/1`. T contém salt de **32 bytes**. O vetor histórico HAP usa salt de 16 bytes somente como oráculo upstream; o vetor de protocolo separado usa salt de 32, código `00001234`, sessionId=01 repetido 32 vezes, a=0b×32 e b=0c×32. Tudo é fixture pública, não segredo real.

Escopos = `E(...escopos ASCII ordenados)` como um campo de T; em G2 é E() vazio. expectedRevision em T é basePRevision. baseCRevision é enviada no open e incluída no descritor de commit abaixo; alteração será detectada por receipts e impede commit. As duas revisões são inteiros ASCII canônicos entre 0 e Number.MAX_SAFE_INTEGER−16; geração alvo = anterior+1, sem wrap. Gestão nunca escolhe arbitrariamente a geração do Player.

Escolha única, sem alternativa residual:

```
TH = SHA256(T)
Dkey(IKM,label) = HKDF-SHA256(IKM, salt=TH,
                            info=E("KQ-Pair-v1",label), length=32)
kBindP = Dkey(K,"bind-player")
kBindC = Dkey(K,"bind-controller")
R      = Dkey(K,"recovery-root")
kCP    = Dkey(R,"commit-player")
kCC    = Dkey(R,"commit-controller")
kQP    = Dkey(R,"recovery-player")
kQC    = Dkey(R,"recovery-controller")
```

K tem 64 bytes. Somente R (32 bytes) precisa ser persistido cifrado para reconstruir commit/recovery. **Commit sempre deriva de R desde o início**; nunca tentar reconstruir chave derivada diretamente de K usando R. Não persistir K, a/b, salt/verifier para retomar SRP. M1/M2 são os HAP efetivos de 64 bytes do provider, não a variante sem identidade; binding usa exatamente os MACs da §3, com versão nova em T. Comparar todo MAC com timingSafeEqual após comprimento=32.

O protocolo não negocia suites: SHA-256 de TH/HKDF/MAC e SHA-512 do SRP têm finalidades distintas. Versão incorreta é erro terminal; nenhuma queda para SHA-256 de params[3072]. Nonces e IDs são CSPRNG de 32 bytes, independentes. UUIDs canônicos são 36 bytes ASCII; fingerprint é 32 bytes binários SHA256(DER), nunca hash de PEM. Nomes de exibição não entram na autoridade.

### 11.5 Descritor, cinco receipts e estados persistidos

Player só gera prepare depois de verificar bindC. Seja token=32 bytes CSPRNG, tokenHash=SHA256(token), pairingId=32 bytes CSPRNG, op=operationId de open. Descritor canônico, nesta ordem:

```
B = E("KQ-Pair-record","kq-pair/1",TH,pairingId,op,
      targetGeneration,basePRevision,baseCRevision,tokenHash)
D = SHA256(B)
```

IDs/cert/roles/finalidade/pin estão comprometidos por TH. Não serializar ciphertext do cofre nesse hash: muda por reencrypt e não é compartilhado. Prepare carrega B em base64url, token em base64url, T em base64url e receipt; receptor reconstrói/verifica B/T e hash do token. Não confiar num B opaco sem validar cada campo contra a sessão local. T permanece <16 KiB; não duplicar PEM no prepare: obter cert do canal G1 e persistir localmente com pin conferido.

Para cada receipt i:

```
Xi = E("KQ-Pair-receipt","kq-pair/1",type,TH,pairingId,op,
       targetGeneration,basePRevision,baseCRevision,tokenHash,previous)
 tagi = HMAC-SHA256(keyDirection,Xi)
 next = SHA256(E(type,tagi))
```

previous de prepare é D; de cada seguinte é next do anterior. type é ASCII exato; nenhuma revisão mutável/ciphertext é inserida depois. Registro guarda B, D, TH, R cifrada, token cifrado/hash, receipts confirmados e revisão local. receipt wire é `{type,tag}`; previous e direção são reconstruídos pela fase, não escolhidos pelo peer. Receipts têm 32 bytes, digests idem. A revisão local é CAS no owning store, distinta de revisão base autenticada.

| Ordem/type/direção | Pré-condição durável antes de emitir | Revisão local resultante | Autorização |
|---|---|---|---|
| 0 prepare P→C, kCP | P pending com B/token/R | P=baseP+1 | Negada |
| 1 prepared C→P, kCC | C prepared com prepare | C=baseC+1 | Negada |
| 2 committed P→C, kCP | P committed com receipt prepared | P=baseP+2 | Negada |
| 3 final C→P, kCC | C committed com receipt committed | C=baseC+2 | Negada |
| 4 active P→C, kCP | P active com receipt final | P=baseP+3 | Só identidade/capacidade técnica, zero escopo de negócio G2 |
| conclusão local C | C active com receipt active | C=baseC+3 | UI pode declarar vínculo confirmado, aguardando reconciliação |

P pode declarar vínculo persistido após active: tem evidência prepared e final da Gestão persistidos; Gestão pode continuar uncertain por resposta perdida. Isso não significa que somente P persistiu. Nenhuma resposta finita permite garantir que ambos sabem simultaneamente que o outro recebeu o último ACK. Não acrescentar ACKs infinitos. active não altera offline/epoch/fila/playback nem libera controles; G4/H fazem reconciliação e autorização operacional.

Retry idêntico de cada receipt devolve exatamente o receipt já salvo, sem nova gravação, token ou geração. Mesmo operationId com D/tag diferentes falha CONFLICT; fase antiga não retrocede estado. Um writer serializado/CAS; nenhuma chamada de rede aguardada dentro de transação. Segundo Controller recebe ALREADY_BOUND/BUSY inclusive em pending/uncertain. Não usar TTL para apagar pending. Token nunca sai do bootstrap antes do bind; bootstrap não aceita Authorization. Token de pending/committed não passa RemoteAuthorizationPort.

### 11.6 Recovery exato

Somente TLS estrito com pin persistido daquela transação, certificado válido e sem redirects; nunca enviar bearer antigo ao candidato desconhecido. Gestão já preparada possui R. Antes de preparada, se perdeu SRP/R, não há recuperação autenticada automática: Player conserva pending bloqueado e oferece abortar localmente e refazer código. Isso evita criar um trust unilateral via status público.

Pedido `/confirm` type=`status`: payload `{pairingId,nonce,localPhase,receiptDigest,mac}`. nonce aleatório novo de 32 bytes, localPhase em prepared/committed/active, receiptDigest=next do último receipt persistido. MAC=kQC sobre E(`KQ-Pair-recovery`,`kq-pair/1`,`query`,TH,pairingId,op,targetGeneration,nonce,localPhase,receiptDigest). Envelope carrega op/sessão/attempt originais. Sem campos desconhecidos, querystring, cookies ou Authorization.

Resposta payload `{pairingId,nonce,phase,receiptDigest,receipts,mac}`. receipts é prefixo contíguo completo da cadeia disponível, em ordem, sem token; MAC=kQP sobre E(`KQ-Pair-recovery`,`kq-pair/1`,`answer`,TH,pairingId,op,targetGeneration,nonce,phase,receiptDigest,E(...E(type,tag) de receipts)). Gestão só aceita nonce de pedido pendente, uma vez, e valida todos os receipts. Status é leitura, não avança fase. Reenviar os receipts faltantes usa os mesmos IDs/bytes; permitidos os avanços da tabela, com CAS. Reordenado/incompatível falha, não inventa resultado. Receipt de prepared válido pode chegar novamente depois de restart: Player resolve pela transação durável original.

Não é necessário persistir todo nonce de consulta: replay de query só devolve status para detentor de R, não autoriza operação. Resposta antiga não atende nonce fresco; descartar resposta depois de cancelamento/generation fence. Teto de um pedido pendente por transação, timeout de transporte G1, quotas próprias continuam aplicadas. Revogado nunca retorna token nem active, mesmo com MAC antigo válido; resposta autenticada tombstone usa R retida cifrada até recuperação local/limpeza explícita, ou erro genérico sem dados se R foi apagada. Nunca aceitar R como bearer.

### 11.7 Schemas de mensagens fechados propostos

JSON externo não é material diretamente MACado. Envelope exato sempre `{version,type,sessionId,operationId,attemptId,payload}`; version=`kq-pair/1`, campos binários em base64url canônico. open usa sessionId/attemptId como string vazia (única exceção às larguras); poll/cancel antes da tentativa usam attemptId vazio; demais usam IDs originais. Respostas repetem o envelope com type abaixo. Rejeitar duplicatas de chaves, extras, UTF-8 inválido, profundidade>6 e corpo>16 KiB. Nomes exibidos como texto até 64 caracteres, sem controles; são informados/não verificados.

| Rota/type | Chaves exatas de payload |
|---|---|
| request/open | controllerId,displayName,nonceC,purpose,baseCRevision,expectedGeneration |
| response/opened | playerId,nonceP,sessionCapability,basePRevision,targetGeneration,state |
| request/poll ou cancel | sessionCapability |
| response/state | state,remainingSeconds,attemptsRemaining (sem código) |
| proof/start-attempt | sessionCapability |
| response/challenge | salt,B,playerFingerprint,serverName,profile |
| proof/client-proof | A,M1 |
| response/server-proof | M2,playerBind |
| confirm/controller-bind | controllerBind |
| response/prepare | transcript,descriptor,token,receipt |
| confirm/prepared | receipt |
| response/committed | receipt |
| confirm/final | receipt |
| response/active | receipt |
| confirm/status / response/status-result | Payload de recovery da §11.6 |
| response/error | code (enum §5),state |

state somente estados da máquina §5/§11.5 e terminais; remainingSeconds 0..120, attemptsRemaining 0..3. Inteiros do protocolo são strings decimais canônicas inclusive revisões/contadores; não aceitar JSON number para eles. purpose initial/renewal, profile exato. sessionCapability só controla poll/cancel do pedido, não dispensa consentimento ou prova. client-proof correlacionado à única tentativa corrente; demais ações não autenticadas sem capability ou proof válido falham. Respostas antes de bind são não confiáveis e não mudam trust. Capacidade ou nonce isolado não autentica nome/controllerId.

Receipts JSON `{type,tag}` correspondem exatamente ao binário §11.5. Erro sem sessionId válido ecoa IDs sintaticamente válidos recebidos ou vazio, sem vazar sessão de outro solicitante. HTTP 202 para espera, 200 para resposta concluída; 400 inválido, 403 falha de autenticação/rejeição, 409 ocupado/conflito, 410 expirado, 429 quota, 503 storage/incerto. Falha após commit nunca apresentada como prova de rollback.

### 11.8 Renovação anual — revogar antes de promover

Escolha simples e explícita: renovar requer operação local no Player, pode interromper disponibilidade **remota**, preserva playback local. Não fazer rotação transparente com duas credenciais ativas. Avisos 30/7 dias são dados para G5, não UI implementada aqui.

1. Revalidar ação local/revisão. Fence RAM e gravar tombstone da geração anterior; confirmar revogação durável antes de qualquer promoção. Falha mantém remoto bloqueado e dados preservados.
2. Gerar chave/certificado candidato por serviço G1 validado, mesmo deviceId estável, novo material RSA/CSPRNG/serial/365 dias; cifrar chave no cofre. Gravar journal de renovação contendo operationId, base/target generation, fingerprint antigo, bundle staged cifrado e estado staged. Não mostrar cert/chave ao Renderer.
3. Fechar listener antigo/WS sem parar playback. Promover o bundle staged em arquivo de identidade por replace durável, validar correspondência chave/certificado/readback; journal passa promoted. Arquivo de autorização permanece revogado. Nenhum passo volta para o bearer antigo.
4. Reiniciar listener somente com certificado novo válido e deny-all, oferecer mesmo consentimento/código guiado pela LAN. pairing novo usa purpose=renewal e geração tombstone+1. Pin antigo não é automaticamente substituído; Gestão inicia explicitamente bootstrap da renovação, sem enviar credencial antiga. Finalizar journal só após active durável.

Crash em staged/promoted: startup carrega tombstone/journal antes da rede; compara fingerprints dos bundles/identidade para completar a mesma promoção idempotente, sem gerar outro certificado e sem restaurar autorização anterior. Se arquivos divergem/corrompem, bloquear remoto e apresentar recuperação local; preservar mídia/SQLite/filas/preferências. Se cofre falha, não promover chave. Se cert antigo já expirou, o caminho local continua disponível para staged mesmo sem listener: não passar pelo loadOrCreatePlayerIdentity que rejeita expirado para iniciar rede. Extensão mínima necessária G1 é API de leitura/recovery local que valida estrutura/chave sem conceder uso operacional a certificado expirado. Cert novo expira antes de concluir: abortar localmente staged e preparar nova renovação, nunca aceitar vencido.

Gestão abandonada/offline não bloqueia revogação local; segundo Controller só entra após revogação explícita. Retomar computador/perfil novo exige novo vínculo; não copiar ciphertext entre contas nem juntar autoridades. Rollback malicioso de disco pelo próprio usuário continua fora da garantia; power-loss/replace Windows deve ser testado no owning store em G2.3.

### 11.9 Experimentos executados, evidências e limites

Harnesses em [scripts/validation](../scripts/validation/g21-qualification.cjs); artefatos públicos de teste em [evidence/g21](evidence/g21/README.md). Dependências temporárias somente em `/tmp/kq-g21-qualification`. Nenhum script é importado pela aplicação nem foi adicionado a package.json/CI. Metadata/tarballs externos foram tratados como dados, sem npm install ou scripts externos executados; o código SRP sob avaliação foi executado apenas no harness autorizado.

- `g21-qualification.cjs`: integrity/recompilação; perfil HAP; vetor conhecido e implementação independente; senha errada, M1/M2 alteradas/truncadas, reflection e replay de outra sessão; A/B inválidos; falta de largura; fault injection u=0; RFC5869 caso 1; alteração de **cada um dos 24 campos** do transcript, separação de direções e árvore recovery. Execução em Node 24.15.0 e Electron 45.0.0 **Run-As-Node**, Node embutido 24.22.0: PASS das assertions. Não é E2E Electron com BrowserWindow/Main nem Windows.
- `g21-tls.cjs`: dois certificados RSA fictícios, sockets HTTPS reais. Canal direto valida; prova ligada ao cert A retransmitida pelo endpoint TLS B é recusada por fingerprint autenticado; cliente confiando em A recusa B em TLS. PASS após execução autorizada fora do sandbox. Primeira tentativa falhou EPERM no bind; não foi convertida em resultado criptográfico. É experimento do binding com K de vetor SRP real, **não implementação completa das rotas G2 nem proxy SRP em dois processos**.
- `g21-recovery.cjs`: processos Node novos por escrita, arquivo com fsync/rename/fsync diretório Linux; sete cortes entre as seis etapas duráveis, repetição da última intenção, perda de resposta e retomada do modelo; tombstone não reativa; MAC de direção/digest alterados recusa. PASS do modelo. Não injeta falha dentro de sync/replace, não simula power-loss, não testa cofre, não é implementação de store G2; essas coberturas continuam na matriz G2.3.
- `g21-primitives.py`: cryptography 41.0.7 independente, backend OpenSSL, coincidência HKDF da árvore, TH, cinco receipts e MACs query/answer de recovery com Node: PASS. Vetores completos hex versionados, incluindo T bruto e seus comprimentos prefixados; exemplos usam fixtures determinísticas públicas. Não usar suas chaves/códigos em produção.

Custo de oito trocas locais completas por execução: consultar min/max/média em node-result/electron-result. Aproximadamente um segundo por troca no host disponível; inclui criação cliente+servidor e setA/setB. Não é benchmark de hardware do estabelecimento nem mede exploit de timing. Exponenciação é síncrona, logo bloqueia o event loop que a executa; worker é requisito da futura arquitetura, ainda não testado como solução de produto.

Correções no harness durante preparação: emit TypeScript isolado confundia reexport de tipo com valor; comparação passou usando Program emit com resolução entre fontes. Fixture inicial de N+1 sofria overflow do último byte; substituída por 384 bytes ff (>N), sem relaxar o cenário inválido. Valor público 1 foi descoberto como rejeitado pelo provider; caso de encoding curto usa 2, registrando a guarda mais restritiva. Vetor histórico de salt16 separado do vetor contratual de salt32. São correções de experimentos novos; nenhum teste existente do produto foi alterado ou enfraquecido.

Não executados: E2E completo de pareamento (não existe G2.2), worker/Main com duas janelas reais, cofre Windows, runner nativo/CI Windows, fault injection de armazenamento dentro de syscalls, quotas/restarts do coordinator real, multicast/LAN física. Não necessário recompilar/testar toda aplicação: nenhum consumidor de produção mudou. Nenhum resultado desses grupos é inferido pelos PASSs isolados.

### 11.10 Handoff e decisão

B1 deixou de ser mera inspeção documental: pacote e fonte fixados, emit comparado e SRP real confrontado com dois oráculos externos. B2 tem escolha única de árvore, bytes, mensagens, receipts, recovery, revisões e renovação; evidências exercitam primitivas e modelos, não provam segurança universal da composição. B3 continua bloqueante: biblioteca com tempo variável, manutenção/releases antigos e ausência de qualificação de canais laterais no contexto definido. Não chamar o protocolo auditado.

Plano após resolver B3 e obter aprovação: Luna implementa provider encapsulado com guardas públicas/worker; schemas fechados §11.7 e fixtures §11.4–6; coordinator Main/presentation port restrito; store único/CAS/receipts/recovery/revogação; staging de renovação; integração ports G1. G2.3 então testa cada janela de falha real/concorrência/IPC/Windows/package da matriz §8, inclusive negativos faltantes do recovery MAC, limites/nonce/certificado expirado e dois processos com SRP/TLS/identidades independentes. Nada disso é autorizado nesta rodada. G5 mantém gate de apresentação segura aprovada; G4/H mantêm reconciliação e controles.

Decisões do proprietário: aprovar ou revisar política adicional de lockout persistente e renovação revoga-primeiro; escolher prosseguir na qualificação de segurança de um provider SRP mantido ou autorizar investigação de provider alternativo. Aprovação do proprietário não substitui evidência B3 nem autoriza remover os critérios. Não há alternativa já qualificada para ser instalada automaticamente.

**G2.1 tecnicamente pronta para aprovação: NÃO. Contrato pronto para implementação pelo Luna: NÃO (B3 aberto). G2.2/G2.3: NÃO INICIADAS.**

Revisão Sol da retomada: árvore/bytes/encadeamento sem incoerência grave identificada; manter B3 bloqueado e limitar B1/B2 aos experimentos. A ressalva sobre TLS experimental motivou substituir o teste pela fórmula exata player-bind (kBindP, TH, M1/M2) com DER observado. Recovery continua modelo: progressão de estados e MACs são verificados separadamente; não há fluxo de rede validando receipts/status integralmente. Isso pertence à futura implementação e não é declarado PASS aqui. Corrigida ambiguidade entre derivar chaves internas do binding e liberar capacidades após o bind.

## 12. Decisão final B3, lockout e renovação — retomada de 2026-11-12

**Estado vigente: B3 BLOCKED; provider aprovado para produção: NENHUM.** A investigação delimitou o bloqueio, em vez de presumir que tempo variável é automaticamente explorável ou que rate limiting o corrige. B1/B2 e seus vetores permanecem válidos nos respectivos alcances. Esta seção substitui a política revoga-primeiro e a decisão pendente de lockout das seções anteriores. Não há implementação G2.2/G2.3.

### 12.1 Threat model e parecer específico

Atacante na mesma LAN pode anunciar Player falso, terminar TLS com certificado próprio, iniciar/cancelar pedidos, controlar A/B e provas, repetir mensagens e observar tamanhos/latência. LAN privada não é fronteira de confiança. Consentimento local impede iniciar SRP útil sem operador, mas não autentica sozinho o peer que responde. Código aleatório curto é seguro somente se o PAKE preservar a resistência a dicionário offline.

Rate limiting persistente, uma sessão, novos salt/a/b por tentativa e cache idempotente retiram muitas oportunidades de amostragem adaptativa do atacante **remoto**. Comparação das provas é sobre valores de 512 bits derivados de segredo, não sobre os oito dígitos diretamente; um delta de tempo de comparação não equivale a descobrir um dígito do código. Não foi demonstrada exploração remota do pacote no fluxo Karaoke Queue. O microbenchmark de provas não encontrou nem refutou um oracle explorável: exceções, JIT, GC, ruído e ordem dos lotes interferem. Não usar essas medições para afirmar tempo constante.

Há três classes locais distintas: (a) administrador/malware com leitura da memória dos processos já compromete código/chaves e não é contido por PAKE; (b) observador da TV/janela vê o segredo — G5 precisa restringir apresentação, sem prometer proteção a código observado; (c) código co-residente sem acesso autorizado à memória/ao cofre pode tentar canais laterais de cache/CPU. Não excluir (c) silenciosamente como se fosse necessariamente (a). Worker é isolamento de scheduling/V8, **não barreira de cache, usuário do SO ou segredo**.

Evidência primária nova: [PARASITE — CCS 2021](https://ddealmei.github.io/assets/pdf/papers/2021_ccs_parasite.pdf) demonstrou dicionário offline com um único traço de cache em implementações SRP baseadas em exponenciação variável OpenSSL. **Não demonstra exploração do jsbn/fast-srp-hap**, que não usa OpenSSL para seus inteiros. Demonstra, contudo, por que poucos palpites, senha efêmera e validade curta não bastam como argumento geral contra esse tipo de vazamento. A [RFC8125, implementação](https://www.rfc-editor.org/rfc/rfc8125#section-4.1) trata proteção contra canais laterais como requisito de implementação.

No artefato fixado, jsbn `bnModPow` seleciona janelas/índices e ramificações pelo expoente; o provider usa g^x derivado do código. `checkM1/checkM2` usam igualdade hex de strings. Portanto não existe garantia de tempo constante; nenhum controle do protocolo remove essas operações. Não há evidência suficiente para transformar esse risco em aceitável sem restringir o threat model. O parecer definitivo é **não aprovar esse provider agora**, mesmo com os controles de rede e worker funcionando. Isso não acusa uma vulnerabilidade de extração de senha já reproduzida.

Evidência exata que falta para aprovar fast-srp-hap@2.0.4: avaliação específica do caminho g^x/modPow e comparação de provas no artefato jsbn/V8 distribuído, cobrindo informação obtida em um traço e o adversário co-residente (c), ou provider substituto que remova esses caminhos variáveis com implementação/vetores verificáveis. Histogramas de tempo total/mais handshakes não suprem essa evidência. Não recomendar fork, jitter, sleeps, timeout uniforme ou quotas como correção criptográfica.

### 12.2 Comparação objetiva e alternativa selecionada para qualificação

| Opção | Segurança/manutenção observada | Electron/Windows/Linux e custo de integração | Decisão |
|---|---|---|---|
| fast-srp-hap@2.0.4, SRP HAP | B1/B2 positivos; jsbn e comparação variáveis; release 2021. Worker/quota não corrigem canais laterais | CJS sem dependências npm, JS incorporado; Node/Electron Linux comprovados; Windows ainda não comprovado nesta rodada. Menor mudança em B2 | Rejeitado para liberação atual; manter como referência qualificada funcionalmente |
| secure-remote-password@0.3.1 | Tarball inspecionado: usa jsbn/modPow/equals; perfil fixo 2048/SHA256. Não resolve o motivo do B3; release antiga | CJS e sete dependências npm declaradas, sem addons; apenas inspeção, sem executar/instalar suas transitivas. Mudaria perfil/provas/vetores B2 | Rejeitado: troca sem vantagem de segurança demonstrada |
| spake2-wasm@0.2.0, SPAKE2 | Artefato WASM executou; fonte upstream referencia crate spake2 0.2.0. Não foi estabelecida correspondência reproduzível ou auditoria desse binário. [RustCrypto spake2 0.4.0](https://docs.rs/spake2/0.4.0/spake2/) avisa ausência de auditoria e de proteção garantida contra timing — isso não prova que o binário 0.2.0 tenha igual código | CJS/WASM + arquivo wasm; smoke Node passou, mensagens de 33 bytes/chave32. Sem Windows/ASAR/vetores RFC9382 independentes. Requer novo perfil, provas e confirmation | Rejeitado como substituição imediata; não presumir que trocar SRP por SPAKE2 elimina o B3 |
| @serenity-kit/opaque@1.1.0, OPAQUE | Artefato MIT, CJS/ESM com WASM inline, sem dependências npm runtime declaradas (há dependências Rust incorporadas). [opaque-ke](https://github.com/facebook/opaque-ke) tem histórico de auditoria NCC, e o wrapper tem [revisão 7ASecurity de 2023](https://7asecurity.com/reports/pentest-report-opaque.pdf). **Não atesta automaticamente o release 1.1.0/2026** nem a composição deste produto | Worker real Node/Electron Linux executou registro local e troca, rejeitou senha errada, resposta alterada e finish de outra sessão. Sem Python/serviço/addon nativo; aguardar ready é obrigatório. Argon2 custa CPU/RAM. Windows/ASAR/vetores independentes e proveniência ainda pendentes | **Alternativa mais viável e alvo único recomendado para qualificação**, sem adoção silenciosa |

Fontes do comparativo: tarballs/metadata npm fixados em `b3-artifacts.json`; [secure-remote-password integer](https://github.com/LinusU/secure-remote-password/blob/master/lib/srp-integer.js), [spake2-wasm Cargo](https://github.com/okdistribute/spake2-wasm/blob/main/Cargo.toml), [OPAQUE upstream](https://github.com/serenity-kit/opaque). Fontes master/main só corroboram a inspeção e não substituem mapear release a fonte. A auditoria 7ASecurity revisou wrapper/crypto/exemplos em 2023; seus achados em exemplos não autorizam copiar servidores de exemplo. O histórico NCC cobre versões antigas do opaque-ke, conforme README; não declarar a versão atual integralmente auditada.

Protocolo aprovado como direção continua SRP/código + binding TLS da T1; nenhum outro foi adotado. **Recomendação de caminho técnico: qualificar OPAQUE com @serenity-kit/opaque@1.1.0**, pois dispõe de wrapper utilizável e histórico de revisão específico; provider recomendado **para produção** continua NENHUM até fechar os três itens delimitados da §12.7. Não iniciar nova busca ampla por bibliotecas.

### 12.3 Evidência executável B3 e limites

Novos harnesses isolados, sem imports de produção ou dependências permanentes:

- `scripts/validation/g21-b3-worker.cjs`: SRP real contra fixture de B1/B2, worker pronto por handshake, supervisor continua processando callbacks durante cálculo, encerramento/terminate aguardado, nenhuma mensagem result após cancelamento e novo worker funciona. Inicialização do WASM ocorre antes de ready; não depender de sleeps para sincronização. Terminate cancela workload despachado; não instrumenta o ponto exato de instrução dentro da exponenciação. Não implementa PairingCoordinator, apenas exercita lifecycle de Worker.
- Mesmo harness executa OPAQUE 1.1.0 real: registro inteiramente local, mesma chave bilateral, senha errada/KE2 adulterado/KE3 de outra sessão recusados. É teste de um provider, **não vetor independente nem prova RFC9807**. Não publicar chaves/records gerados; resultado registra apenas métricas e larguras.
- Microbenchmark de mismatch M1 nos bytes 0/31/63, 12 lotes de 1000 verificações por classe: amplificação de laboratório que ignora deliberadamente o budget real. Não é ataque remoto, não estima probabilidade de exploração e não atesta tempo constante. Os segredos deste teste são fixtures públicas.
- `g21-b3-artifacts.cjs`: SHA512 confere com metadata dos três tarballs alternativos; SPAKE2 smoke com mesma senha produz chave igual e senha distinta produz chave diferente. Falta confirmação autenticada e vetores externos para qualificação SPAKE2.
- `g21-b3-policy-model.cjs`: relógio monotônico injetado, cinco reservas antes de custo, duplicata, falha de escrita sem admissão, reserva incerta após crash, reinício conservador, expiração sem RTC; seis cortes do modelo de renovação e ausência de autoridade entre tombstone e novo pareamento. Não valida store, energia/NTFS, cofre ou permissões reais.

Resultados completos em `docs/evidence/g21/b3-*.json`. Execuções em Node 24.15.0 e Electron 45 Run-As-Node/Node24.22; não são UI Electron nem Main de produto/Windows. Medidas do supervisor são proxy de responsividade do event loop; não teste audiovisual sob carga. Guardas públicas/u=0/transcript negativos continuam cobertos pelas evidências anteriores, sem repetir integralmente B1/B2. Uma tentativa inicial do novo teste tratou resposta OPAQUE adulterada como retorno undefined, mas o parser rejeitou por exceção: o harness passou a aceitar somente undefined ou erro de protocolo explícito. O negativo continua exigindo rejeição, nunca aceitando login.

Nenhuma execução de worker, microbenchmark ou handshake converte B3 em PASS. Native Windows, ASAR da alternativa e cofre estão NOT RUN; autorização/scheduling/safeStorage G1 não foram modificados ou reabertos.

### 12.4 Lockout persistente — direção aprovada, contrato final proposto

Sem banco nem serviço novos. Usar o mesmo arquivo durável de autoridade já **planejado para G2**, com infraestrutura FS/cofre da G1; não afirmar que G1 já implementa esse store. Não pôr quotas no SQLite operacional nem criar arquivo de autoridade paralelo. Adicionar ao envelope `{storeRevision,authorityRevision,pairingBudget}`. authorityRevision conserva as revisões autenticadas de B2; storeRevision faz CAS de todas as escritas (inclusive quota) e não entra no transcript. Assim, consumir uma tentativa não altera a revisão de vínculo no meio do SRP.

pairingBudget contém no máximo cinco entradas `{attemptId,status}`; status `reserved|failed`. Não contém código, verifier, chave, salt ou IP como autoridade. IDs são aleatórios do protocolo; nunca vêm de log/Renderer genérico. Antes de cada tentativa cara, sob writer/lock único do perfil: ler último estado → expirar entradas pelo relógio monotônico → validar budget/sessão → gravar reserva durável/readback → só então liberar worker. Até três tentativas por sessão consentida, no máximo cinco falhas/reservas globais por dez minutos. Reserva concorrente conta enquanto pendente. Não reservar duas vezes para mesmo attemptId; payload conflitante é rejeitado sem repetir criptografia. Quota de requests/DoS G1 continua separada.

Falha autenticação transforma reserved→failed, sem segunda cobrança. Sucesso libera somente a própria reserva, após confirmação criptográfica; não apaga falhas anteriores. Crash/cancel/timeout depois da reserva deixa tentativa cobrada conservadoramente, pois resultado é incerto; não devolver crédito por perda de comunicação controlável pelo atacante. Crash antes da reserva confirmada não pode ter iniciado worker. Guardas baratas de tamanho/formato fora de sessão consentida usam limites G1, não geram escrita ilimitada por pacote malformado.

**Escolha simples para resistir a restart e RTC errado:** enquanto o processo vive, cada entrada expira 600000 ms depois da reserva por relógio monotônico; em cada boot, entradas persistidas recebem conservadoramente 600000 ms desde o boot, independentemente de data de parede. Não persistir/interpretar deadlines de performance.now entre processos; não confiar em relógio avançado/regressivo para liberar palpites. O preço é até dez minutos de espera adicional após reinício, mesmo se o computador ficou desligado dias. Isso não reduz os limites aprovados, não adiciona temporizador sofisticado nem permite bypass por reboot. Reinícios repetidos podem prolongar a espera; **um processo funcionando dez minutos termina a penalidade**, sujeito a storage íntegro. Não prometer janela deslizante exata através de apagões.

Expiração/limpeza deve ser persistida antes de nova admissão. Se write/readback/CAS falhar ou arquivo ficar corrupto, pairing bloqueado, sem fallback vazio; playback local permanece. Arquivo ausente no primeiro uso só é criado pelo owner sob exclusão do perfil e identidade válida, não é tratado automaticamente como reset quando existe evidência de autoridade anterior. Não reaproveitar operação incerta para reservar novamente.

Recuperação local segura: mostrar tempo restante real do monotônico; aguardar dez minutos com processo aberto permite tentativa após limpeza durável e novo consentimento. Não expor botão remoto/IPC genérico “zerar tentativas”, nem bypass por senha/admin. Se arquivo não é recuperável, operação local explícita de recuperação preserva cópia, invalida toda autoridade antiga via procedimento durável e inicia budget cheio/cooldown de dez minutos; não concede confiança ou remove tombstone silenciosamente. Falha de disco exige reparo do armazenamento, não relaxamento da autenticação. Essa operação de recuperação é contrato futuro G2/G5; não foi implementada.

### 12.5 Renovação — preparar antes, revogar na promoção

A política final proposta é **preparação antecipada por ação local seguida de promoção cercada**, em substituição ao revoga-primeiro da §11.8. Não é renovação automática. O objetivo é não perder disponibilidade remota válida por falha na geração/cifragem/gravação inicial; nunca ter duas autoridades.

1. Operador inicia Renovar vínculo no Player. Capturar operationId/revisão/fingerprint antigo; preparar novo certificado e chave via gerador G1, mesmo deviceId, pin novo/validade365 dias. Cofre deve cifrar chave antes de qualquer staging. Old identity/autoridade ficam preservadas, e canal antigo só continua se cert válido e modo permitir. Nenhuma troca silenciosa de pin.
2. Gravar no **mesmo arquivo G2 de autoridade** um renewal journal `staged` com operationId, base authorityRevision/geração, oldFingerprint, bundle antigo cifrado recuperável e bundle novo cifrado validado. Não sobrescrever identidade ativa ainda. Exigir flush/readback e validar novo cert↔chave. Falha aqui conserva identidade antiga: não revogar nem apagar por efeito colateral. Staged pode ser cancelado localmente antes da etapa 3, preservando o vínculo antigo.
3. Sob writer único, fence RAM, parar novas admissões, revalidar mesma autoridade/revisão. Uma única gravação atômica do arquivo G2 une **tombstone da credencial antiga + geração incrementada + renewal.phase=promoting**; esperar confirmação durável. Fechar canais antigos e callbacks por geração. Nenhuma autorização ao bundle staged. Se resultado da escrita for incerto, manter remoto bloqueado e reler/reconciliar; não afirmar cancelamento nem retomar token antigo por palpite.
4. Promover bundle staged para arquivo de identidade G1 com replace durável/readback e validação de pin/chave. Journal passa `awaiting-pair`; listener novo usa somente certificado válido e autorização deny-all. Arquivo de identidade não é autoridade: carregar journal/tombstone G2 antes de abrir rede em qualquer restart. O certificado antigo ainda existente em disco não restaura sua credencial.
5. Repetir descoberta → seleção → consentimento → código8 → novo vínculo persistido conforme B2, purpose renewal, nova geração após tombstone. Sem bearer antigo no bootstrap, sem arquivo/QR/IP/fingerprint na UI. Só active durável encerra renewal journal; limpeza de bundles antigos ocorre depois de confirmação e jamais reativa autorização anterior. Não apagar SQLite, acervo, preferências, histórico ou dados operacionais.

Recuperação por fronteira: antes de staged, antigo intacto; em staged, usar o mesmo novo bundle já salvo ou cancelar localmente; após promoting, só avançar/reparar para o novo, nunca desfazer tombstone. Se identidade em disco tem oldFingerprint, promover o novo já salvo; se tem newFingerprint, validar e concluir marcação; se tem outro pin/corrupção, bloquear remoto e preservar journal/cópias para recuperação local. Crash entre replace da identidade e journal é detectado por esses fingerprints, sem emitir nova chave nem duplicar vínculo. Nenhuma transação distribuída entre os arquivos é presumida.

Certificado expirado nunca é aceito no canal operacional nem temporariamente para “recuperar”. Se o antigo expirou antes do staging, usar caminho local que lê/valida bundle para recuperação sem abrir listener expirado; gerar certificado novo e seguir etapas. Se o staged expirar enquanto aguardava, substituí-lo somente por nova ação local/revisão, mantendo tombstone se já promovia. Cofre indisponível, disco cheio ou readback falho bloqueiam promoção/rede; playback local não depende dessa manutenção. Até concluir testes de durabilidade Windows, não prometer resistência comprovada a perda de energia em NTFS; preservar ambos os bundles evita destruição intencional, não substitui essas verificações.

### 12.6 Impactos precisos em B2 se OPAQUE for aprovado

**Nenhuma alteração de protocolo foi aplicada.** Os itens seguintes são o delta obrigatório de uma substituição proposta; não são um contrato OPAQUE já aprovado. B2 SRP `kq-pair/1` permanece íntegro, sem alterar vetores retrospectivamente.

Preservar: consentimento/código8, CSPRNG, 120 s, sessão única, budget, certificados/identidade G1, pin observado, nonces/IDs/finalidade/gerações, encoding E, confirmação bilateral do fingerprint, árvore R→commit/recovery, descritor/receipts/CAS, incerteza e deny-all, recuperação e renovação com consentimento. Não mudar fila/controleEpoch/autoridade G4/H.

Mudar de forma versionada: `kq-pair/2`, domínio HKDF `KQ-Pair-v2` e perfil OPAQUE fixado depois da qualificação (sem negociação/fallback SRP). Remover salt/A/B/M1/M2 HAP e provider SRP; usar KE1/KE2/KE3 opacos da biblioteca, com largura validada conforme suite. Na configuração default do **experimento** 1.1.0: KE1=96, KE2=320, KE3=64, sessionKey=64 bytes e registrationRecord=192 bytes; isso não congela sozinho uma suite para produção. IKM passa a ser sessionKey decodificada, não exportKey. ExportKey não é compartilhada pelo servidor e não pode substituí-la.

Player faz registro OPAQUE **inteiramente local** usando o código que gerou e setup efêmero do provider; só depois atende login remoto. Não aceitar registrationRecord da Gestão nem inventar registro sobre TLS provisório. Setup/record são por sessão, não banco de contas ou segundo vínculo permanente. Identifiers client/server devem vincular os IDs e papéis acordados; TH também deve incluir suite/configuração de stretching e bytes KE1/KE2/KE3, no lugar dos campos SRP. A escolha e encoding desses campos novos precisam de novos vetores; não reinterpretar A/B como KE1/KE2 para manter a versão.

Ordem: KE1 Gestão → KE2 Player → KE3 Gestão → Player verifica finishLogin → Player bind → Gestão bind → prepare/receipts. Gestão só obtém sessionKey após finishLogin válido; Player não publica bind/prepare antes de validar KE3. Confirmar certificado no transcript recomputado de cada lado continua obrigatório. MAC Player/Controller de binding deve autenticar TH e os três KE, com chaves e rótulos separados; o formato final só será congelado na revisão da substituição, sem formulação PAKE própria. Armazenamento de R/receipts pós-pareamento continua possível sem manter setup/record/código, conforme KDF versionada nova.

A alternativa não está liberada ao Luna para completar essas decisões. Registro efêmero local, Argon2/perfil, vetores de KE e binding têm de ser fechados no pacote de qualificação abaixo antes de implementar G2.2.

### 12.7 Próximo gate específico — sem nova rodada genérica de pesquisa

Provider aprovado para produção: **NENHUM**. Provider-alvo recomendado: **@serenity-kit/opaque@1.1.0**, OPAQUE, sem adoção automática. Caminho delimitado, caso o proprietário aprove a substituição da T1:

1. **Artefato→fonte→auditoria:** verificar proveniência npm/commit e dependências Rust efetivamente compiladas do tarball SHA256 `7ea879bb56cefddf59216a0242936e595ff9310ef4b6efa4111256e6834b94ab`. A declaração SLSA obtida do registry aponta para `ca1cb22f03b9e456159ce367e2975124f87f5ad8` e seu subject SHA512 coincide com o tarball; o manifest desse commit declara a constraint opaque-ke `4.0.0`. A assinatura/cadeia/transparência dessa declaração **não foi verificada**, nem o WASM reconstruído ou o grafo Rust resolvido atestado. Não confundir metadata declarada com proveniência criptograficamente validada; o package não declara gitHead. Confrontar alterações desde a revisão 7ASecurity/2023, especialmente backend de grupo/OPRF, constante de tempo, RNG e serialização. Não exigir nem prometer que uma auditoria antiga cobre todo o release novo.
2. **Oráculo independente e delta B2:** executar vetores públicos da suite RFC9807/OPRF correspondente e comparar KE/sessionKey com implementação independente ou referência Rust fixada; incluir record/KE malformados, identities trocadas, pin/TH alterado e KE3 ausente/replay. Congelar `kq-pair/2`, suite/Argon2, registros só locais e bind conforme §12.6. Somente sucesso bilateral do mesmo WASM não satisfaz esse item.
3. **Runtime suportado:** repetir worker/cancelamento no Electron Windows via runner oficial/checkout NTFS, verificar WASM/ASAR e memória/custo Argon2. Isso não autoriza mexer em proteção do runner ou workflows por arrasto. Linux Run-As-Node já tem evidência de funcionamento do artefato; não repetir B1 inteiro.

Se o proprietário preferir manter SRP, a alternativa é obter avaliação **específica de jsbn/V8 descrita em §12.1** ou substituir por provider SRP com operações secretas demonstravelmente protegidas, preservando perfil/provas. secure-remote-password/spake2-wasm avaliados não fornecem essa solução. Não começar nova lista aberta de bibliotecas; não elevar B3 a PASS apenas porque nenhum exploit foi reproduzido.

Plano Luna: após provider/protocolo qualificados e aprovação explícita, G2.2 implementa schemas/provider encapsulado em worker, guardas, coordinator, presentation port seguro, budget persistente antes do custo, store/receipts/recovery e staging antes de revogação; G2.3 comprova concorrência/idempotência/falhas por syscall/restarts/cofre/Windows e negativos do protocolo real. UI real aprovada G5 continua requisito para ativar; G4 reconcilia antes de controle. Nenhum desses lotes foi iniciado.

Decisões restantes: aprovação do caminho OPAQUE/alteração de protocolo T1, ou manter SRP com qualificação específica; aprovação técnica do procedimento de renovação stage-first. Lockout resistente a restart é **direção aprovada pelo proprietário nesta rodada**; a escolha conservadora de dez minutos por boot é a especificação proposta para revisão. Não pedir nova autorização para a análise já executada. B1/B2 não foram reabertos, somente seu delta condicional foi identificado.

**B3: BLOCKED. Provider recomendado para produção: NENHUM. G2.1 tecnicamente pronta: NÃO. Contrato pronto para Luna: NÃO. Aprovação do proprietário: AGUARDANDO.** A causa remanescente está delimitada acima; worker/quota/renovação deixam de ser decisões genéricas em aberto.

Proveniência adicional coletada: endpoint npm `/-/npm/v1/attestations/@serenity-kit%2fopaque@1.1.0`, payload SLSA aponta workflow release.yml/commit ca1cb22f03b9e456159ce367e2975124f87f5ad8; subject confere com o tarball. Resultado preservado como declaração não validada criptograficamente em b3-artifacts.json. Isso estreita a qualificação pendente, sem declarar B3 resolvido para OPAQUE.

Revisão independente Sol da decisão §12: não encontrou incoerência grave; confirmou que B3 BLOCKED/nenhum provider aprovado e OPAQUE como alvo delimitado correspondem às evidências. Considerou coerentes cooldown conservador e stage-before-revoke. Revisão somente leitura, sem reexecutar testes. Cancelamento observado não prova apagamento de segredos, ponto exato de interrupção na criptografia ou fencing do coordinator real; não são alegados. Verificação final de sintaxe dos três harnesses novos, JSON, links locais/whitespace e `git diff --check`: PASS.

## 13. Qualificação OPAQUE 1.1.0 — decisão de adoção

**OPAQUE: NO-GO para adoção nesta rodada. B3: BLOCKED.** Não é uma demonstração de insegurança do algoritmo nem uma incompatibilidade inevitável com a experiência aprovada. Há evidência nova positiva de proveniência, OPRF, TLS e runtime; falta qualificação da autenticação completa do artefato/suite e da composição a congelar. B1/B2 SRP permanecem preservados. §13 substitui a indicação anterior de OPAQUE como próximo candidato automaticamente recomendável; não habilita `kq-pair/2` ou implementação pelo Luna.

### 13.1 Registro inicial: o requisito não pode ser atribuído ao TLS provisório

A [RFC9807 §3.2](https://www.rfc-editor.org/rfc/rfc9807.html#section-3.2) requer confidencialidade, integridade e autenticação do servidor no registro. Portanto, **registro Gestão→Player pela LAN usando somente o certificado candidato da G1 não satisfaz o requisito**. Código digitado não torna aquele TLS retroativamente autenticado; mDNS e nome do Player tampouco o fazem. Colocar outro PAKE antes desse registro duplicaria mecanismos e retiraria boa parte da justificativa do OPAQUE aqui.

A alternativa previamente experimentada é diferente: Player, após consentimento local, cria setup e executa os dois papéis de registro **dentro de seu processo/worker confiável**, com o código que ele próprio gerou. Registro não trafega pela LAN, não depende de certificado candidato e não recebe record da Gestão. Trata-se de pré-provisionamento local; a Gestão posteriormente executa somente o login. A fronteira confiável local supre proteção das mensagens de registro; não há alegação de autenticar um servidor remoto nessa etapa. O código passa a autenticar o AKE posterior, não serve como bearer. Não requer outro protocolo de rede antes do OPAQUE.

Isso é uma aplicação plausível do registro local, **não uma prova de composição do bootstrap inteiro**. O Player conhece o segredo e executa um papel que normalmente caberia ao cliente; perde-se a vantagem de esconder a senha do servidor, que é dispensável neste produto, e acrescentam-se setup/record/Argon2 de registro para um código efêmero. Não se deve concluir que o algoritmo é inútil, nem que esse pré-provisionamento esteja pronto para produção só porque o handshake passou.

No PoC, os identifiers autenticados nativos carregam papel/ID, sessão, finalidade, versão experimental e fingerprint DER: Player registra seu fingerprint local; Gestão usa o DER efetivamente observado no socket TLS. Um terminador TLS com certificado distinto pode retransmitir KE1/KE2, mas não consegue fazê-los validar sob a identidade de servidor reconstruída pela Gestão. Isso foi testado. O experimento usa os mecanismos de identities da biblioteca; **não é aprovação de um novo encoding/wire contract**. O parâmetro de contexto nativo continua `None` na API 1.1.0; não fingir que passar uma propriedade JS `context` o habilita.

Antes do login/binding confirmado, nada concede pin persistente, bearer ou autoridade. Aquele que observar o código e obtiver a sessão consentida continua ameaça; a apresentação local segura de G5 é gate. Falso mDNS pode induzir escolha/DoS, não estabelece trust; anúncios foram representados no teste pela seleção explícita de endpoint falso, não por um novo teste multicast.

### 13.2 Artefato e proveniência — avanço verificável

Tarball fixo 1.1.0/SHA512 e SHA256 registrados em §12 e `b3-artifacts.json` foram preservados. Nesta rodada, o verificador oficial **sigstore@4.1.0**, instalado com scripts desabilitados exclusivamente em `/tmp/kq-g21-opaque-final/verify`, verificou o bundle SLSA publicado pelo npm:

- issuer esperado `https://token.actions.githubusercontent.com`;
- identidade esperada `https://github.com/serenity-kit/opaque/.github/workflows/release.yml@refs/heads/main`;
- assinatura/cadeia, CT e transparência Rekor pelas políticas padrão do verificador, sem zerar thresholds;
- subject SHA512 idêntico ao tarball, commit declarado `ca1cb22f03b9e456159ce367e2975124f87f5ad8`.

**PASS de proveniência** substitui o resultado histórico de assinatura não verificada. Não é rebuild reproduzível nem auditoria do código. A fonte desse commit foi baixada em diretório temporário; CJS/ESM publicados têm WASM inline, sem addon nativo. O registro OPRF determinístico da RFC coincidiu com o binário, corroborando o comportamento da suite declarada, sem provar todo o grafo Rust compilado.

O release workflow usa build Rust e wasm-bindgen; o checkout não versiona Cargo.lock. Cargo.toml especifica constraints, não uma lista exata atestada de transitivas do WASM. Não usar Cargo.lock de uma crate obtida separadamente como se fosse o lock do release. Fonte referencia opaque-ke4.0.0 com Argon2; a crate 4.0.0 foi inspecionada para serialização/changelog, não recompilada nem assumida como backend exato resolvido de todo o binário.

Consulta OSV primária de 1.1.0 npm e opaque-ke4.0.0 crates.io retornou sem advisories nesses dois resultados na data da análise. **Não é auditoria do grafo Rust/npm completo nem garantia de ausência de vulnerabilidades.** Resultado sanitizado em `opaque-final/advisory-query.json`; não foram usadas credenciais reais.

### 13.3 Auditoria: escopo conhecido e delta que não pode ser apagado

O [relatório 7ASecurity/OTF](https://7asecurity.com/reports/pentest-report-opaque.pdf), pp.3–7, registra trabalho em outubro/novembro de 2023, cobrindo wrappers JS/React Native, crypto/fuzzing, exemplos, supply chain e threat model. O relatório público não fixa um hash de release auditado que permita atestar byte a byte 1.1.0. Seus resultados não se estendem automaticamente ao backend atualizado. Os cinco itens de hardening incluíam exemplos/dependências; não são evidência de falha nova no core publicado hoje.

Para comparação objetiva, foi obtido o último commit retornado pelo GitHub até novembro/2023: `6714925d4c65efa1d4b2ded0b5935778b596a6e4`, de setembro/2023, manifest0.8.0. É **checkpoint histórico próximo**, não hash alegadamente auditado. Diff contra o commit de proveniência mostra:

- opaque-ke `3.0.0-pre.4` → constraint `4.0.0`; novas APIs de ServerLogin e KeyExchange;
- Ksf Argon2 direto → CustomKsf, com parâmetros configuráveis, memória default e variante “rfc-recommended” ajustada;
- wasm-bindgen0.2.84 → 0.2.106, serde-wasm-bindgen0.5 → 0.6.5, base640.21 → 0.22.1, tsify0.4.4 → 0.5.6 e adição de generic-array/sha2;
- atualizações de getrandom e glue/serialização. Mudanças de exemplos/build são separadas dos caminhos criptográficos.

O changelog **da crate opaque-ke4.0.0** identifica ajustes posteriores: alinhamento com RFC final, criação obrigatória de dummy record para tratar diferenças de timing, alteração de ServerSetup e serialização; 3.0.0 havia mudado rótulo de transcript e versão OPRF com incompatibilidades. Isso é razão concreta para não transferir a auditoria histórica ao binário atual. Não foi feita auditoria especializada nova desses deltas; não há exploração reproduzida atribuída a eles. Licença MIT do wrapper e licenças permissivas do core precisam permanecer no inventário futuro de dependências, incluindo transitivas Rust.

### 13.4 Suite real e alcance dos vetores independentes

Na fonte declarada pelo release padrão: OPRF ristretto255-SHA512, TripleDH sobre Ristretto255/SHA512, KDF/MAC internos SHA512 conforme core, base64url sem padding; Ksf CustomKsf Argon2id v0x13 com salt de stretching zero de 16 bytes. Esse salt não substitui o OPRF seed aleatório. Default: memória2^16 KiB, iterações3, paralelismo4. `rfc-recommended` usa 2^21−1 KiB, iterações1/paralelismo4; **não executar esse perfil de ~2 GiB por arrasto**. Não se confunde @serenity-kit/opaque com o pacote P256 separado.

Executados no **WASM publicado sem alteração**, dois casos oficiais independentes: RFC9807 C.1.1 e C.1.2, resposta de registro determinística completa (avaliação OPRF + chave pública do servidor). Setup de fixture foi serializado conforme formato publicado do core, usando seed/chave e dummy public key válida dos próprios vetores; a parte dummy não participa da resposta esperada. Resultado exato nos dois casos, em Node e Electron45.

**Isso não é PASS dos vetores AKE completos.** Os vetores oficiais usam KSF Identity/contexto explícito; a API pública 1.1.0 só oferece Argon2 e fixa contexto nativo em vazio, sem injeção pública de RNG. Não modificamos a biblioteca nem implementamos OPAQUE para contornar essa diferença. Falta comparar o AKE/KSF efetivamente escolhido com oráculo independente ou executar vetores adequados por interface de referência qualificada. Conhecer a sessionKey a partir do mesmo provider nos dois lados não supre isso.

### 13.5 Testes negativos, runtime e medições

Harness novo `scripts/validation/g21-opaque-final.cjs`, sem import de produção, executado com HTTPS real e certificados RSA fictícios:

| Cenário | Resultado/limite |
|---|---|
| Registro local e login pela LAN simulada em loopback | PASS; hashes das chaves bilaterais coincidem; nenhum código enviado em claro |
| Código errado; KE2 alterado | PASS; AKE não concluído no harness, que não implementa emissão de credenciais |
| Identidade cliente, versão experimental e finalidade alteradas | PASS; identifiers nativos não validam. Não é teste de parser do futuro protocolo G2 |
| MITM termina TLS com segundo certificado e retransmite KE1/KE2 | PASS negativo; mismatch do identifier com DER observado impede autenticação |
| Trocar certificado depois de fixar candidato | PASS negativo da verificação TLS |
| KE3 de uma sessão usado em outra; KE3 após descarte do estado | PASS negativo |
| Registro local interrompido | Start de registro não emite registrationRecord; não é fault injection ou teste de armazenamento de produto |

14 assertions/cenários registrados por runtime, incluindo os dois vetores parciais. Testes usam somente chaves/códigos fictícios. Não há binding externo criptográfico customizado nesses negativos; utiliza-se identifier nativo autenticado, e hashes de chave só para comparação do harness. O formato experimental não pode ser promovido para `kq-pair/2` sem contrato/revisão completos.

Compatibilidade comprovada: Node24.15.0/Linux, Electron45 Run-As-Node/Node24.22 e **worker executando o pacote dentro de ASAR** com troca bilateral real. Empacotamento isolado usou @electron/asar3.4.1 já presente, nenhum pacote de produto foi gerado. Evidência Run-As-Node não é UI Electron real. Harnesses anteriores de cancelamento/encerramento em worker permanecem válidos e não foram reatribuídos a novos vetores. Windows nativo/ASAR Windows/cofre estão **NOT RUN**: o runner oficial não oferece seleção para este PoC, e não foi contornado ou alterado para executar código pelo source WSL.

A campanha de vetores/negativos levou ~6,26 s Node e ~6,20 s Electron, incluindo geração de dois certificados e vários logins; não é latência de uma tentativa. RSS do processo foi de ~78,9→158,4 MB no Node e ~117,0→194,9 MB no Electron; picos registrados ~151,1/187,1 MiB. O probe ASAR/worker registrou RSS ~190,8 MB após sucesso. São medidas do processo completo, não alocação atribuível exclusivamente ao Argon2, nem teto universal. Suporte técnico local é positivo; custo64MiB de KSF por execução e cancelamento exigem worker e orçamento de memória no produto. Nenhuma mudança em playback/fila.

### 13.6 Decisão, proporcionalidade e consequências para B2

| Pergunta de decisão | Parecer |
|---|---|
| OPAQUE pode atender ao bootstrap sem certificado previamente confiável? | Em princípio, com pré-provisionamento de registro inteiramente local e AKE posterior autenticado pelo código; não pelo TLS provisório. O teste não equivale a composição final aprovada |
| 1.1.0 já tem evidência suficiente para adoção? | **Não**: falta AKE independente da suite real e revisão dos deltas criptográficos/serialização posteriores à auditoria; proveniência e ASAR avançaram |
| Há incompatibilidade comprovada com a UX? | Não. O registro pode ser invisível/local; código8 e reconexão persistida são preserváveis |
| Riscos residuais podem ser declarados aceitáveis agora? | Não estabelecido. Não confundir ausência de ataque com garantia, nem auditoria2023 com release2026 |
| Pode ir para Luna sem decisão criptográfica aberta? | **Não**. Nenhum perfil OPAQUE de produção foi congelado; não delegar essas escolhas à implementação |

**NO-GO é para adoção de 1.1.0 agora**, não rejeição matemática de OPAQUE. OPAQUE exige registro/setup/record e stretching para um código efêmero, sem necessidade do requisito original de esconder uma senha permanente do servidor. Um PAKE balanceado, como SPAKE2 da RFC9382, é conceitualmente mais direto para esse caso. Entretanto, **não há provider alternativo qualificado para produção nas evidências deste repositório**: spake2-wasm e o provider SRP continuaram rejeitados. Não recomendar biblioteca desconhecida nem chamar o SPAKE2 de ADB/BoringSSL, baseado em outra versão de protocolo, de implementação intercambiável da RFC9382. Não introduzir um PAKE antes de OPAQUE.

Recomendação de provider/protocolo para produção: **NENHUM nesta rodada**. Alternativa técnica mais proporcional a apresentar ao proprietário, se ele decidir abandonar OPAQUE: PAKE balanceado RFC9382 com implementação de tempo constante/revisada e testes independentes; isso ainda carece de provider qualificado, não é autorização de pesquisa ampla nem proposta de implementar primitivas. A investigação desta rodada termina com essa decisão, sem abrir outra busca de pacotes.

B2 SRP/receipts/R/recovery não foi modificado para OPAQUE. Estruturas provider-independent de persistência, gerações, incerteza e receipts podem ser preservadas; KE/identifiers/configuração/contexto/IKM e KDF versionada exigiriam novo contrato e vetores. Não reinterpretar M1/M2 ou A/B, não usar exportKey como sessionKey, não manter fallback/downgrade. Sem GO não há schemas OPAQUE finais para Luna preencher por inferência.

Lockout persistente e renovação stage-first da §12 continuam propostas técnicas aplicáveis, com mesma aprovação de direção contra bypass por restart. Se OPAQUE fosse escolhido, admissão/consumo de budget teria de preceder liberação de KE2; ausência de KE3 conta conservadoramente como falha. Setup/record/código seriam efêmeros, sem substituir o vínculo durável por “conta OPAQUE”. Renovação gera certificado antes de revogar/promover e refaz consentimento/código, sem aceitar expirado; nada autoriza mudar essas políticas ou implementar G4/G5/H.

Pendências do proprietário: decidir se aceita manter a etapa bloqueada ou patrocina o fechamento específico da qualificação de AKE/delta auditado; decidir eventual mudança da T1 para outro protocolo e aprovar os detalhes conservadores de lockout/renovação. Não existe autorização de G2.2/G2.3 decorrente destes testes. Plano Luna fica **retido**, sem trabalho de produção iniciado.

**OPAQUE: NO-GO (adoção atual). B3: BLOCKED. G2.1 tecnicamente pronta: NÃO. Contrato pronto para Luna: NÃO. Aprovação do proprietário: AGUARDANDO.**

Revisão independente Sol de §13: não encontrou incoerência conceitual; considerou honestos NO-GO de adoção e B3 BLOCKED, registro local plausível e distinção entre TLS candidato/identifier autenticado. Somente leitura, sem reexecução. Ressalva incorporada: negativos provam falha do AKE no harness, não lifecycle de emissão de credenciais G2 inexistente. O rótulo “before credentials” nos resultados experimentais tem esse alcance limitado. Nenhum aceite do proprietário foi presumido.

Verificação final da rodada: Sigstore também rejeitou payload DSSE adulterado por divergência de hash (negativo PASS); um primeiro expected-error do harness procurava apenas “signature”, corrigido para aceitar o erro específico de hash DSSE, sem relaxar a exigência de rejeição. Sintaxe dos três scripts Node novos, JSON/links locais/whitespace e `git diff --check` PASS. Dependência de verificação e fontes permaneceram em /tmp; nenhum package.json/lock, produção, Doop, F, firewall, commit/push/PR alterado.

## 14. Decisão arquitetural FINAL — recomendação única

O proprietário determinou esta última rodada com critérios proporcionais e escolha obrigatória. Recomendo **OPAQUE-3DH com @serenity-kit/opaque@1.1.0**, registro local no Player, identifiers nativos autenticando CTX/fingerprint e perfil fechado **kq-pair/2**, no [contrato final implementável](g2-1-final-pairing-profile.md). O próximo passo é a decisão do proprietário; não outra rodada genérica de algoritmos. Nenhuma implementação foi iniciada.

O NO-GO da seção13 é histórico: tratava falta do AKE integral independente e auditoria nova dos deltas como bloqueios de qualificação. Na avaliação final autorizada, essas lacunas são riscos residuais explicitamente aceitos **na recomendação**, não PASS inventado ou vulnerabilidade corrigida. Proveniência verificável, core revisado historicamente, dois vetores oficiais parciais, fonte/suite inspecionadas, negativos reais/TLS/ASAR/worker e testes adicionais em processos sustentam um patamar defensável para este app comercial/LAN hostil. Não há evidência de vulnerabilidade grave no caminho escolhido que esteja sendo dispensada. Aprovação informada do proprietário permanece necessária.

SRP/jsbn não foi escolhido pelos caminhos secretos variáveis/manutenção e conjunto de implementação menos favorável; numeric comparison foi analisada por protocolos completos (Matrix SAS, ZRTP, Bluetooth), não hash de oito dígitos. Adaptar suas identidades/commitments/stacks à G1 ampliaria a implementação, enquanto OPAQUE já tem evidência concreta neste runtime. SPAKE2/WASM avaliado não oferece vantagem de qualificação suficiente para justificar trocar novamente. O perfil final preserva digitação de código8 e nenhum conhecimento técnico ao operador.

B2 é reutilizado com substituições explícitas de versão/CTX/KE/KDF, sem reinterpretar provas SRP. Registro OPAQUE não trafega em TLS provisório. Todo CTX vai nos identifiers nativos; contexto opcional da API permanece vazio, por definição do perfil. HKDF/confirmations/receipts da aplicação usam apenas primitivas padronizadas. R deriva de K; commit/recovery derivam de R desde início. Pending salva T completo para retransmitir prepare após crash. Recovery bound autentica R/TH/nonce mesmo sem pairingId conhecido; se Gestão perdeu R antes de salvar, exige recuperação local. Novo perfil não libera bearer antes de provas/consentimento/binding e persistência; /control recebe só o grant técnico transport:control exigido pela G1, sem escopos/dispatch de negócio até G4/H.

[Experimento final](evidence/g21/final-decision/README.md): protocolo real com pacote inalterado em dois processos OS; código/fingerprint/nonce/geração alterados, confirmações divergentes, replay, reset/cancel/timeout e modelo de reserva. Guardas de timeout/concorrência são modelos, não alegação de coordinator/store implementados. CTX e userIdentifier do teste foram alinhados exatamente ao perfil congelado. Python cryptography verifica encoding/KDF/MACs da aplicação independentemente de node:crypto. Não repeti as campanhas TLS/ASAR/worker anteriores sem mudança relevante; full AKE RFC continua explicitamente não executado.

Lockout e renovação finais: reserva durável de3 por sessão/5 globais em10min, cooldown monotônico conservador após reboot, arquivo G2 único/sem DB adicional, fail-closed; stage-first com novo bundle validado antes de tombstone/promoção, recovery por fingerprints e zero dupla autoridade. São propostas para aprovação do proprietário. Código/record/setup são efêmeros; segredo persistido somente no cofre. Nenhuma API privilegiada ou chave privada no Renderer.

Revisão Sol da proposta final identificou duas correções incorporadas: journal deve guardar T/KE completos, e userIdentifier do harness deve usar o domínio e attemptId do contrato. Enum de conflito padronizado REVISION_CONFLICT. Nenhum desses ajustes mudou matemática do provider. A revisão considerou a recomendação proporcional defensável para aprovação arquitetural, sem alegar auditoria nova ou autorização de produto.

**PROTOCOL DECISION: OPAQUE-3DH / @serenity-kit/opaque@1.1.0 / kq-pair/2. SECURITY ASSESSMENT: APTA PARA APROVAÇÃO arquitetural. ACCEPTED TRADE-OFFS: auditoria histórica/deltas sem nova auditoria integral; AKE completo não reproduzido pela API pública; custo Argon2/worker; exposição física/endpoint comprometido; Windows/homologação posteriores; cooldown conservador. G2.1 READY FOR OWNER DECISION: SIM. G2.2/G2.3: NÃO INICIADAS. PROPRIETÁRIO: AGUARDANDO DECISÃO.**

Inspeção final da integração: a G1 exige transport:control para Upgrade WSS. O perfil final concede somente esse escopo técnico ao vínculo active; zero escopos de negócio/rotas/dispatch G2. Isso substitui a ideia de array vazio no draft que impediria conectar. O guard G1 não foi alterado. Verificações documentais finais e sintaxe dos harnesses adicionais: PASS, incluindo git diff --check; produção intacta.

Inspeção final da integração: a G1 exige transport:control para Upgrade WSS. O perfil final concede somente esse escopo técnico ao vínculo active; zero escopos de negócio/rotas/dispatch G2. Isso substitui a ideia de array vazio no draft que impediria conectar. O guard G1 não foi alterado. Verificações documentais finais e sintaxe dos harnesses adicionais: PASS, incluindo git diff --check; produção intacta.
