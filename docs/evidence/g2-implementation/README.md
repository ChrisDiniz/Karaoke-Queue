# G2.2/G2.3 — implementação e evidências

**Estado vigente após reauditoria focal:** A4 PASS, A1–A3 PASS, G2.2/G2.3 PASS, auditoria independente PASS. G2 tecnicamente apta para iniciar G3; G3 não iniciada. Produção NÃO homologada; G5 e G6/H5 permanecem gates. Ver [parecer](../../g2-independent-audit.md).

Data da rodada: 2026-11-12. O perfil normativo é [`kq-pair/2`](../../g2-1-final-pairing-profile.md); a proposta anterior de G2.1 permanece como histórico. Este registro descreve código e execução observados, sem declarar auditoria criptográfica integral ou homologação de produção. Os três smokes Windows nativos foram concluídos nesta atualização.

## Resultado por lote G2.2

| Lote | Resultado | Implementação |
| --- | --- | --- |
| Contratos, schemas e mensagens | PASS | `src/pairing-wire.ts`, `src/pairing-state-machine.ts`; envelopes estritos e versão `kq-pair/2`. |
| Provider OPAQUE | PASS | `src/opaque-pairing-worker.ts`, `src/opaque-worker-client.ts`; pacote exato `@serenity-kit/opaque@1.1.0`, worker criado/terminado pelo Main. |
| Registro e código local | PASS | Player cria o registration record após consentimento local; código uniforme de 8 dígitos por `crypto.randomInt`, um único slot, expiração de 120 s. |
| Consentimento e cancelamento | PASS | Ports Main-side com estado explícito; cancelamento/timeouts fecham worker. Sem port aprovado, bootstrap fica desabilitado. |
| Confirmação e binding | PASS | Transcript canônico `kq-pair/2`, context/identifiers OPAQUE, provas mútuas e binding ao fingerprint TLS observado e identidade do Player. |
| Persistência bilateral e recovery | PASS | Cinco receipts encadeados; journal, confirmação durável antes de publicar, status autenticado, retries idempotentes e estado incerto fail-closed. |
| Credenciais, autorização e revogação | PASS | Token individual cifrado por safeStorage e hash no adapter; somente `transport:control`; fence imediato e tombstone durável. Nenhuma rota de negócio H criada. |
| Lockout persistente | PASS | Reservas antes do trabalho OPAQUE, máximo 3 por sessão/5 globais em 10 min; falha de leitura/gravação nega admissão. |
| Renovação stage-first | PASS | Novo certificado e bundles cifrados em staging; old/new fingerprint no journal; promoção após commit bilateral, recovery antes do listener e validação operacional recusa certificado expirado. |
| Adapters G1 | PASS | Reuso dos ports de bootstrap, TLS pinning, identidade e deny-all; integração mínima em `src/main-remote-runtime.ts`. |

`PairingBootstrapService` só aceita ativação com presentation port Main-owned marcado como aprovado. O app não cria nem liga esse port a uma UI G5 nesta rodada; por padrão, o endpoint de pareamento fica desabilitado. Fixtures de consentimento existem somente em testes.

## Evidências executadas

- `npm run compile` — **PASS**.
- `npm run test:unit:pairing` — **PASS** para worker OPAQUE real, handshake bilateral, proofs/binding, bootstrap e lifecycle, vectors de transcript/receipts, wire parser, store/lockout, e renovação. O subprocesso de rede do script imprimiu `NOT RUN` no sandbox padrão por falta de interface RFC1918; foi executado à parte com permissão de rede e passou.
- `node scripts/pairing-process-integration.test.cjs` em execução autorizada com sockets — **PASS**: Player filho e Gestão no processo de teste, HTTPS real em endereço RFC1918 local, certificado pinado, OPAQUE real, código errado seguido de tentativa correta, falsa identidade de descoberta rejeitada, perda de ACK de `prepare` e `active`, recovery autenticado, vínculo após restart e revogação local persistente após outro restart. Fechamento do Controller após commit não emite um cancelamento contraditório. O adapter safeStorage deste harness é uma fixture de teste; não prova DPAPI.
- `node build/tests/remote-infrastructure.test.js` em execução autorizada com sockets — **PASS 18/18**, regressões TLS/HTTPS/WSS/deny-all G1.
- `node scripts/windows-native-runner.test.cjs` — **PASS 39/39**, incluindo a exceção hash-pinned do adapter safeStorage; validação unitária do runner/seletor.
- `node --test scripts/windows-build-provenance.test.cjs` — **PASS 6/6**, incluindo caminho POSIX/Windows de extração de manifests ASAR.
- Smoke de distribuição isolado no **Electron 45.0.0, Node 24.22.0, Linux**: pacote temporário `app.asar` com os módulos compilados e o pacote OPAQUE publicado; Electron Run-As-Node carregou `MainOpaqueWorker`, abriu worker pelo caminho ASAR e fez registro OPAQUE real — **PASS** (`KQ_PACKAGED_OPAQUE_WORKER=PASS`). Isso comprova o caminho ASAR/WASM nessa plataforma, não Windows nem um instalador final.
- Versão observada localmente: Electron `45.0.0`, Node embarcado `24.22.0`, módulos ABI `150`. Dependência direta única adicionada: `@serenity-kit/opaque@1.1.0` exata; o pacote distribui WASM e JS e não introduziu addon nativo/serviço.

### Cobertura dos riscos de protocolo

| Caso | Evidência | Alcance |
| --- | --- | --- |
| Código incorreto/retry | OPAQUE real em worker e no processo de integração — PASS | Senha errada não completa AKE; a tentativa válida usa novo `attemptId`. |
| Timeout/cancelamento | Clock/barreiras de lifecycle e terminação de worker — PASS | Não usa sleeps arbitrários; cobre o estado local/serviço. Não é uma simulação de perda de energia Windows. |
| Impersonação de descoberta/certificado | Player/Management separados, probe G1 e TLS pin — PASS | Certificado cujo deviceId diverge da seleção é rejeitado antes de abrir vínculo. |
| Alteração de provas/contexto e replay | Vetores G2.1 reutilizados em [`final-decision`](../g21/final-decision/README.md) — PASS no escopo descrito ali | O harness G2.1 encaminha provas entre processos, mas não é a rota HTTP do produto. Não se atribui cobertura maior que a documentada. |
| ACK perdido/retry | Processo HTTPS independente — PASS | `prepare` e resposta final perdidos; consulta autenticada recupera o mesmo journal e receipts. |
| Concorrência de solicitação | Lifecycle — PASS | Um segundo `open` enquanto há sessão ativa recebe BUSY e não substitui consentimento. Não simula duas contas Windows. |
| Lockout e restart | Store/relógio injetado + safeStorage real em Windows — PASS | Reserva persistente, cooldown conservador em novo boot, limites 3/5 e falha de escrita fail-closed. O smoke DPAPI exercitou persistência/recuperação de credencial, não perda de energia nem múltiplas contas Windows. |
| Revogação após restart | Processos Player consecutivos — PASS | Bearer antigo não autoriza depois do tombstone durável. |
| Falha de escrita bilateral/renovação | Injeção no store e restart simulado — PASS | Readback/CAS preserva estado incerto. DPAPI/safeStorage foi exercitado nativamente; perda de energia/NTFS durante commit continua sem teste dedicado. |

## Compatibilidade Windows e Electron

| Tecnologia | Compatibilidade documentada | Testes existentes do projeto | Integração G2 específica em Windows |
| --- | --- | --- | --- |
| Node `worker_threads` / Electron Main | Node documenta `worker_threads` como estável e indicado para CPU intensiva. Electron Main executa Node; o worker G2 usa apenas Node APIs e não acessa `electron` nem APIs Renderer. [Node Worker Threads](https://nodejs.org/api/worker_threads.html), [Electron Multithreading](https://www.electronjs.org/docs/latest/tutorial/multithreading). | Worker OPAQUE/cancelamento passou em Node 24.22 e Electron 45 Run-As-Node Linux. | Smoke oficial PASS em Windows x64, Node `24.11.0`, com dois processos de pareamento e encerramento limpo dos workers. |
| OPAQUE JS/WASM | `@serenity-kit/opaque@1.1.0` inclui glue JS e WASM, sem addon nativo na árvore/runtime package. WASM não exige binding N-API/MSVC. | Handshake real nos workers Node/Electron; carregamento e registro real no `app.asar` Linux PASS. | PASS em worker e pacote Electron Windows 45; o executável empacotado carregou `app.asar`, criou worker Main-owned e realizou registro OPAQUE real. |
| `safeStorage` assíncrono / DPAPI | Electron expõe `safeStorage` no Main; a API async é não bloqueante e em Windows usa DPAPI. Electron documenta proteção contra outros usuários, não contra outros apps sob a mesma conta. A API sync está deprecated no Electron 45 e é removida no 46. [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage), [Electron 45](https://www.electronjs.org/blog/electron-45-0). | Adapter usa `isAsyncEncryptionAvailable`, `encryptStringAsync` e `decryptStringAsync`; G2 unitários usam protector injetado. | PASS em Electron Windows: dois processos usaram o mesmo perfil isolado, persistiram e recuperaram credenciais cifradas; o JSON não continha os valores em claro. Limite entre apps da mesma conta permanece. |
| ASAR, worker e WASM | Electron trata arquivos ASAR como diretório virtual para `require`/Node APIs; addons nativos são uma classe de distribuição distinta. [ASAR Archives](https://www.electronjs.org/docs/latest/tutorial/asar-archives). | Worker criado a partir de caminho `app.asar` e OPAQUE WASM carregado no Electron 45 Linux — PASS. | PASS em candidato Windows oficial; verificador e smoke no `Karaoke Queue.exe` carregaram módulos de `app.asar` e executaram OPAQUE real. Não cobre instalação NSIS/UAC/ACLs. |
| Dependências/distribuição | Nenhum novo módulo nativo, runtime externo, serviço ou regra de firewall. O pacote OPAQUE é uma dependência JS/WASM fixada exatamente em 1.1.0. | Manifesto/verificador Windows exige o pacote/versionamento e inclui fontes G2. | Build candidato NSIS x64 e verificação PASS; assinatura não configurada. O smoke executou o unpacked Electron; não instalou o NSIS. |

### Resultado dos três smokes Windows solicitados

| Smoke | Resultado | Motivo |
| --- | --- | --- |
| 1 — dois processos Windows, OPAQUE + worker | **PASS** | `pairing-opaque-worker` executou OPAQUE real em workers Main-owned, confirmou proofs/binding, rejeitou código incorreto e encerrou os workers; a integração Player/Management também passou em processos independentes Windows. |
| 2 — Electron real, DPAPI/safeStorage e vínculo após restart | **PASS** | Duas instâncias Electron 45, mesmo perfil temporário isolado: `safeStorage` assíncrono cifrou o token e recovery root, gravação em `remote-authorization.json` sem valor claro, reinício recuperou e validou a credencial. O perfil foi removido pelo fixture. |
| 3 — candidato Windows empacotado, worker + WASM | **PASS** | `build:windows`/`verify:windows-build` oficiais passaram; Electron x64 empacotado executou registro OPAQUE real a partir do `app.asar` e fechou o worker. Candidato não instalado nem publicado. |

### Ambiente, fingerprints e correções

Execução nativa através do runner oficial e checkout NTFS, sem usar WSL como substituto do Windows: Windows `10.0.26200`, PowerShell `5.1.26100.9711`, x64, Node `24.11.0`, npm `11.6.1`, Electron `45.0.0`, electron-builder `26.18.0`, MSVC Build Tools 2019 `16.11.36602.28`, Python `3.14.0`. Smoke 1/2: branch `feature/remote-player-lan-integration-3`, HEAD `75af81822fdc929ea5c011ad6a5efa73bfcf24c2`, fingerprint `34d91ff15005f6fa1e8ce1065ec1c5ca72a848d5f8e6e20562ce0f6b9c8204f3`. Smoke 3: mesmo HEAD, fingerprint `20634474b8589f71a493aa77e450b61a93d9f51841648935061bcbfc21b67932`; candidato `Karaoke-Queue-Setup-0.5.0-x64.exe`, SHA-256 `8af6dec349330b3daa51aeaf1fde11bc099b81379173f8c6dd31178f63ddc9a0`. O build foi selado, verificado e incluiu 1.057 entradas no ASAR.

O bloqueio inicial era a regra `isSensitivePath`: o padrão de nomes detectava o segmento `secret` em `src/remote-secret-protector.ts`. O conteúdo foi revisado; contém somente interfaces e o adapter Electron `safeStorage`. O runner mantém o deny-by-default e agora aceita exclusivamente esse caminho, com SHA-256 fixo da origem LF (`e934ab4b948413d2d80aeea717bc2cb18b4e6edade77b7a19c8efac428f53441`) ou da forma CRLF de checkout Git Windows (`e800e0cc56f23219f55de093a09c509132c00ea9a2cf50203be2fb8bfc4d9a21`), apenas como `tracked`/`adopted`. Arquivos untracked, caminhos vizinhos, bytes diferentes e exclusões continuam bloqueados. Regressão do runner: **39/39 PASS**. O bootstrap revelou a conversão `core.autocrlf=true`; a segunda forma exata foi necessária para adoção verificada do clone inicial.

Na primeira execução G2, o teste de shutdown do HTTPS/WSS revelou `write EBADF` quando o abort de autorização rejeitava a Promise e o ramo `catch` tentava responder em socket durante fechamento. A correção fecha o socket e libera reserva sem resposta quando o transporte está encerrando; regressão focada Linux passou e a suíte Windows remota passou **18/18**.

A primeira verificação do pacote candidato falhou porque `@electron/asar` em Windows requer o separador nativo na chamada `extractFile`; o manifesto era listado com `\\`, mas extraído usando `/`. O helper agora usa `path.join`, com teste POSIX/Windows; a suíte de proveniência passou **6/6**. A tentativa seguinte foi recusada porque havia um `dist/` parcial não selado. Ele foi preservado e o pacote final validado num segundo checkout NTFS novo; nenhum artifact anterior foi sobrescrito. A integração mDNS multicast de ambiente permanece opt-in e foi reportada como skipped; G6/H5 físico não foi executado.

## Limites e pendências

- G2.2 está tecnicamente implementada conforme `kq-pair/2`. G2.3 está **PASS** nos testes focados e nos três smokes Windows nativos. Isso deixa G2 apta para auditoria independente, sem representar homologação de produção.
- G2 está apta para auditoria independente; isso não é uma auditoria aprovada nem homologação de produção.
- G2 não habilita pareamento de produção sem apresentação local real, segura e aprovada em G5. Este ticket não fornece consentimento sintético fora de testes.
- Nenhum frame Doop, G3/G4/G5/H, Fase F, firewall, serviço, dados de usuário ou perfil real foi alterado/ativado. Nenhum segredo real foi usado.
- Homologação em dois computadores fica em G6/H5. G1 continua com seus limites de validação multiplataforma documentados.


## Auditoria independente posterior

Os PASS acima são históricos nos cenários executados. A [auditoria Sol](../../g2-independent-audit.md) corrigiu A1–A3 e revalidou o runner Windows remoto (fingerprint `83c7783afed07048c2184926fb240e77768ae261fc3ebec818f1b143385a4301`). Seu reproducer A4 inicialmente falhou com um journal indevido. O addendum corrigiu A4 com ponto de admissão e reconciliação; reproducer OPAQUE real, cancelamento/falha/restart e revogação durante renovação admitida passaram em `npm run test:unit:pairing`. Neste último caso, o vínculo antigo foi revogado e o journal pending não avançou nem concedeu autorização. A4 RESOLVIDO, reauditoria pendente; G2.2/G2.3 PARTIAL, G3 ainda não iniciada. Smokes Windows anteriores não foram repetidos porque a mudança não é específica de plataforma.


## Reauditoria focal final

A4 e regressões relacionadas reexecutadas: PASS. Novo teste OPAQUE real `--cancel-after-write-unreadable` confirma cancelamento false, blocked/RESULT_UNCERTAIN, autorização negada e arquivo preservado após falha inconclusiva. A1–A3 3/3 PASS. Sem defeito adicional de produção; Windows/ASAR anteriores preservados. Processo LAN desta rodada NOT RUN (sem interface RFC1918). G2.2/G2.3 e auditoria PASS; tecnicamente apta para G3, sem iniciá-la. Produção NÃO homologada.

### Reauditoria para o checkpoint local

A revisão final da working tree encontrou e corrigiu a guarda de inicialização duplicada em `MainRemoteRuntime.startPlayer()`: uma segunda chamada após startup não pode substituir referências ao listener/anúncio ativos. A regressão testa listener HTTPS local e fechamento; compilação **PASS**, `remote-infrastructure` **19/19 PASS**, e a suíte `test:unit:pairing` **PASS** após a correção. O subprocesso LAN ficou **NOT RUN** nesta repetição por ausência de IPv4 RFC1918; veja o relatório de auditoria para a evidência anterior e o escopo exato. G2 permanece apta a iniciar G3, que não foi iniciada. G5 e G6/H5 continuam pendentes para homologação de produção.
