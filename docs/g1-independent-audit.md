# G1 — revisões independentes e evidências G1.3

## Aceite do proprietário — G1 homologada com limitações — 2026-11-12

O proprietário aceitou a G1 e determinou seu encerramento como **homologada com limitações**, após o parecer técnico independente favorável. G1.2 está concluída; G1.3 foi aceita com as limitações abaixo. Esse aceite substitui o estado anterior de “aguardando aceite final”; os resultados técnicos históricos permanecem preservados e a validação integral de todas as plataformas não é declarada.

- Windows nativo: NOT RUN; o runner oficial bloqueou o arquivo-fonte `src/remote-secret-protector.ts` pela heurística de nome sensível antes da sincronização. A execução nativa continua pendente.
- Empacotamento: smoke ASAR focado PASS; rebuild limpo pendente por indisponibilidade externa/DNS (`EAI_AGAIN github.com` na tentativa anterior).
- Multicast real local WSL: PASS; LAN entre computadores e plataformas nativas permanece para G6.
- E2E audiovisual com MP4: NOT RUN, sem fixture aprovada; não bloqueia o aceite da infraestrutura G1.

A G1 está tecnicamente apta para G2 e seu aceite pelo proprietário está registrado. G2 permanece não iniciada e depende de autorização própria. T2, D2 e os demais gates futuros permanecem vigentes. Nenhum resultado NOT RUN foi convertido em PASS. Este checkpoint não encerra a Fase G inteira.

**Parecer independente final de 2026-11-12:** não foram encontrados defeitos novos críticos/altos ou bloqueantes no escopo auditado. G1.2 está tecnicamente conforme à T1; G1.3 segue parcial por validações ambientais pendentes. A infraestrutura está tecnicamente apta para iniciar G2, mas G1 não está integralmente homologada. Isso é uma avaliação técnica; não satisfaz por si só o pré-requisito canônico “G1 aprovada” do ticket G2, não inicia G2 e não substitui a autorização do proprietário.

O registro abaixo preserva a auditoria de correções da rodada anterior; o último registro contém as verificações repetidas nesta revisão final.

## Achados e correções

- **Alta — erros WSS sem listener (correção anterior preservada):** após handshake, o cliente removia o único listener `error`; WebSockets aceitos também podiam emitir erros sem tratamento. Um erro de parser/socket poderia encerrar o Main. `remote-clients.ts` e `remote-transport.ts` mantêm tratamento permanente, fechamento e liberação do agente no evento close. A regressão usa TLS/WSS real, frame cliente sem máscara e erro pós-handshake.
- **Alta — multicast não era recebido pelo bind UDP:** `multicast-dns` usa `opts.bind || opts.interface` no `socket.bind`. O adapter passava somente o endereço da interface e, portanto, vinculava a porta 5353 ao IP unicast em vez de wildcard. O teste real expirava por essa configuração. O Player e a Gestão agora usam bind `0.0.0.0` somente no socket UDP multicast, mantêm `addMembership` na interface selecionada e validam que a origem IPv4 privada pertence à mesma subrede antes de processar respostas/consultas. Não muda o bind HTTPS/WSS. Após a correção, o teste real de anúncio, descoberta e goodbye passou no WSL.
- **Média — cache `bonjour-service@1.4.4`:** a inspeção da implementação mostrou cache `_services` sem limite configurável, `expire()` vazio, respostas idênticas sem renovação de TTL e atualização de A record sem substituir o endpoint. A dependência foi removida de `package.json`/lock; depender de detalhes privados ou reiniciar o browser para limpar registros seria frágil.
- **Média — ciclo de consulta:** a primeira versão do adapter próprio enviava apenas uma consulta PTR ao iniciar. Mesmo com cache correto, um Player ativo deixaria de ser anunciado localmente quando o TTL expirasse. Agora Gestão consulta novamente e revalida a interface selecionada a cada 60 segundos, abaixo do TTL publicado de 120 segundos.
- **Média — isolamento de interface:** registros iguais recebidos em interfaces diferentes compartilhavam chave de cache. Isso poderia cruzar endpoints entre redes. A chave passou a incluir a interface e a reconstrução de candidatos usa somente registros recebidos naquela interface.
- **Baixa — anúncios fora do serviço e concorrência:** registros mDNS sem relação com o tipo DNS-SD do Karaoke Queue podiam ocupar o limite antes de formar candidatos. Agora o cache aceita somente PTR/SRV/TXT/A relacionados à cadeia do serviço; a troca/revogação de endereço e o cache-flush ficam limitados à interface correspondente.
- **Média — update concorrente com shutdown:** o `update()` do publisher aguardava o goodbye, enquanto `stop()` podia retornar antes de a atualização abrir um novo socket. O lifecycle agora serializa start/update/stop; stop chamado durante update só conclui depois de fechar também o novo socket. Uma regressão usa callback/barreira controlada e comprova que não resta anúncio vivo.

O adapter conserva DNS-SD e usa `multicast-dns` no Main, com cache limitado a 512 registros e 64 candidatos, registros limitados por pacote e campos TXT/nomes limitados. Respostas duplicadas renovam expiração; cache-flush atualiza endpoints; goodbye TTL zero e TTL vencido removem candidatos; stop limpa sockets, timer, cache e candidatos. A alteração da interface selecionada, detectada por nome estável, fecha o socket e consulta pelo endereço/netmask novos. O bind wildcard se restringe ao UDP multicast e cada datagrama aceito precisa vir de IPv4 privado na subrede selecionada. Anúncios, nomes e `deviceId` permanecem não verificados: não mudam pin, vínculo nem autorização.

## Regressões e evidências automatizadas

`tests/remote-discovery-cache.test.ts` contém **7 testes determinísticos** com relógio, eventos e timers injetados: resposta repetida/TTL; troca de IP/cache-flush; origem fora da subrede rejeitada; goodbye/expiração; anúncios válidos acima do limite de candidatos; flood de registros malformados e não relacionados; limite interno de 512 e externo de 64; consulta e detecção de mudança de interface a cada 60 s; cache isolado por interface; start/stop/restart concorrentes e ausência de recursos após shutdown. `tests/remote-infrastructure.test.ts` contém **18/18** testes, incluindo as opções de bind multicast, filtragem de consultas por origem e corrida update/stop.

O harness `scripts/remote-process-integration.test.cjs` iniciou Player e Gestão como processos Node independentes, em perfis temporários separados, usando certificado X.509 de teste real, HTTPS/WSS real, rota/port sintéticos exclusivos do teste e interface IPv4 privada. Encerrou o Player, reiniciou-o com o mesmo perfil e verificou identidade, certificado e reconexão. O protector de segredos do harness é deliberadamente de teste; não comprova criptografia nativa. Nenhum route/authorization bypass de teste é exportado para produção.

Resultados no Linux/WSL desta execução:

- `npm run compile` e **`npm run test:unit` — PASS** na árvore final de produção, após as correções de bind/origem e lifecycle; o teste mDNS opt-in permanece skipped no comando padrão, pois exige `KQ_RUN_MDNS_INTEGRATION=1`.
- Foco remoto: infraestrutura TLS/WSS **18/18 PASS**, cache de descoberta **7/7 PASS**, rede privada TLS/HTTPS/WSS **1/1 PASS**, processos independentes **1/1 PASS**; grupo junto **27/27 PASS**.
- Teste multicast real opt-in — **PASS** após correção: Player anuncia, Gestão descobre o candidato como não verificado e shutdown retira o anúncio. É validação real de sockets no mesmo host/interface WSL; não equivale a duas máquinas nem à homologação LAN Windows/Linux nativa.
- Electron 45 real sob Xvfb, `scripts/remote-safe-storage-electron.test.cjs` — **PASS fail-closed**: API disponível, backend Linux `basic_text`, `remoteEnabled=false`, nenhuma identidade criada. Isso não é evidência de cofre Linux habilitado.
- Linux ASAR — **PASS focado pós-correção**: extraí o `app.asar` Linux previamente construído, substituí somente `build/src/remote-discovery.js` pelo módulo compilado atual, repacotei em diretório temporário e Electron 45 Run-As-Node carregou as duas classes do adapter com as dependências incluídas no ASAR. Uma nova build limpa por `electron-builder` falhou em `EAI_AGAIN github.com`; o smoke focado não substitui essa build. Não comprova pacote/instalação Windows.
- `npm ls --package-lock-only --depth=0` — **PASS**, sem Bonjour no contrato de dependências. O `node_modules` preexistente ainda contém `bonjour-service@1.4.4` como extraneous; o ASAR final confirma que ele não foi empacotado.
- `scripts/windows-native-runner.test.cjs` — **38/38 PASS** após incluir o novo teste determinístico de cache DNS-SD no modo remoto Windows.
- Segunda revisão independente do Sol — confirmou que os dois achados estavam corrigidos; repetiu infraestrutura/cache **25/25 PASS** e multicast real local **1/1 PASS**, sem apontar novo defeito no escopo revisado.
- O E2E Standalone de produção — **NOT RUN**: não há MP4 de teste aprovado no repositório. Não foi usado acervo pessoal. Procedimento futuro: obter uma fixture autorizada, somente de teste, contendo `01001.mp4`; apontar `KQ_PLAYER_TEST_MEDIA_DIR` para o diretório isolado e executar `npm run test:e2e:standalone-production:headless`. Para Windows, usar o runner oficial e caminho Windows para a mesma fixture autorizada.

## Multicast real, Windows e CI

O primeiro ensaio opt-in terminou em `MDNS_DISCOVERY_TIMEOUT`. A revisão de código e comparação de socket isolou a causa: bind UDP no endereço unicast da interface. Após bind wildcard limitado ao socket mDNS e filtro de origem/subrede, o mesmo ensaio real passou em aproximadamente 0,6 s no WSL. Assim, o timeout anterior não deve ser atribuído somente ao ambiente. A passagem comprova a troca multicast local no ambiente disponível; LAN entre computadores, redes Windows/Linux nativas, VPN/guest e DHCP em rede física continuam sem evidência.

Validação Windows nativa — **NOT RUN**. A sessão não oferece execução Windows; o runner oficial havia parado na fronteira WSL/Windows com `UtilBindVsockAnyPort:307: socket failed 1`. Não foi alterado o sistema nem sincronizado checkout NTFS. O workflow existente `.github/workflows/pr-validation.yml` já tem job `windows-latest` para build x64, safeStorage Electron nativo e verificação de pacote. O runner oficial também expõe `npm run test:e2e:remote-infrastructure:windows`; sua seleção agora inclui a regressão de cache. Não foi criado nem disparado workflow. A suíte Windows e o resultado nativo seguem pendentes.

## Limites e conclusão

Não houve validação entre computadores físicos. Electron Windows, descoberta em LAN nativa de Windows/Linux e E2E Standalone com mídia aprovada permanecem **NOT RUN**. O teste determinístico cobre `PlayerAdvertisementPort.update()` com goodbye TTL zero no IP antigo e anúncio do IP novo; monitoramento automático de mudanças de rede e rebind do listener HTTPS no runtime não foram conectados nesta etapa, pois a coordenação de recovery/endereço pertence à integração G4. O harness local de processos não equivale a G6 ou homologação física; `basic_text` foi corretamente bloqueado. A revisão confirmou separação Main/Preload/Renderer, deny-all sem G2, TLS pinado e ausência de alteração em fila, playback, persistência operacional, Doop, firewall e Fase F. G1.2 permanece implementada; G1.3 está parcialmente validada. O Sol confirmou P1/P2 corrigidos e não encontrou outro defeito dentro do escopo revisado; permanecem validações ambientais e aprovação final da G1. G2 não iniciada.

## Auditoria independente final — 2026-11-12

### Parecer de segurança e arquitetura

Inspecionei novamente a T1 aprovada e os módulos Main-only de transporte, clientes, TLS, identidade, proteção de segredos e descoberta. Não encontrei vulnerabilidade crítica/alta ou defeito funcional bloqueante novo. Permanecem válidas as correções anteriores dos erros permanentes de WSS, do bind UDP multicast, do cache DNS-SD limitado e da serialização `start/update/stop` do publisher.

- TLS operacional continua com `rejectUnauthorized: true`, certificado próprio RSA-2048/SHA-256 validado, SAN por identidade, pin SHA-256 calculado diretamente do DER e versões TLS 1.2–1.3. O probe inicial sem validação de cadeia continua limitado a obter um candidato de certificado: não envia requisição de aplicação e não concede confiança.
- O servidor HTTPS/WSS usa o endereço de interface explicitamente selecionado. `0.0.0.0` permanece restrito ao socket UDP mDNS; origem e sub-rede são verificadas antes de aceitar anúncio/consulta.
- Sem G2, autorização continua deny-all na composição normal. Não há rotas de negócio, IPC ou método de preload que inicie o transporte no startup normal. Descoberta mantém candidatos `verified: false` e não autoriza, fixa pin ou altera vínculo.
- A fronteira Main/Preload/Renderer e os invariantes de playback, fila, banco operacional e histórico permanecem sem alteração.

### Validações repetidas nesta auditoria

- `npm run compile` — **PASS**.
- `remote-infrastructure.test.js` — **18/18 PASS**; inclui certificados reais de teste, pin TLS, deny-all, handshake/versionamento, payloads, revogação por port sintético, WSS, shutdown e corridas de listen/close.
- `remote-discovery-cache.test.js` — **7/7 PASS**; TTL repetido, troca de endpoint, goodbye/expiração, limites, isolamento por interface, mudança de interface e shutdown/start-stop.
- `remote-private-network.test.js` — **1/1 PASS** com HTTPS/WSS real em interface privada.
- `remote-process-integration.test.cjs` — **1/1 PASS**: Player e Gestão em processos distintos, certificado real, HTTPS/WSS real, identidade persistida após morte/reinício do Player e perfis temporários isolados. A proteção de segredo deste harness é sintética e não valida armazenamento nativo.
- Soma do grupo remoto automatizado — **27/27 PASS**. Uma tentativa inicial dentro do sandbox não conseguiu estabelecer os sockets locais; a mesma bateria foi executada pela via aprovada e passou. O resultado considerado é o da execução aprovada.
- `KQ_RUN_MDNS_INTEGRATION=1 node --test build/tests/remote-discovery-multicast.test.js` — **1/1 PASS** em multicast local real: anúncio, descoberta como não confiável e retirada no shutdown, no WSL. Não equivale a LAN entre computadores.
- Electron 45 sob Xvfb, `remote-safe-storage-electron.test.cjs` — **PASS fail-closed**: Linux reportou `basic_text`, desativou armazenamento remoto e não criou identidade.
- Smoke de módulo em ASAR, com o Electron 45 Run-As-Node — **PASS focado**: pacote Linux preexistente em `/tmp/kq-g1-audit-package-final`, módulo DNS-SD substituído pela compilação atual em cópia temporária, classes carregadas com dependências do ASAR. O pacote original não foi alterado.
- `npm ls --package-lock-only --depth=0` — **PASS**; `multicast-dns@7.2.5`, `selfsigned@5.5.0` e `ws@8.22.2` são as dependências declaradas; Bonjour não está no contrato.
- `npm run test:unit` completo — **não repetido nesta auditoria**; os testes focados diretamente relacionados à G1 foram repetidos. O PASS anterior permanece evidência histórica, não é atribuído a esta rodada.

### Validações ambientais e limites

- **Windows nativo — NOT RUN.** A interoperabilidade PowerShell funcionou pela via aprovada e o runner oficial foi invocado apontando para o clone NTFS existente. O runner parou antes de sincronizar qualquer arquivo: `src/remote-secret-protector.ts`, que é código-fonte e não contém credencial, foi bloqueado pela heurística de caminho sensível. Nenhum conteúdo foi transferido e o clone não foi alterado. Não removi nem contornei a proteção do runner. O job Windows do CI existente não foi disparado.
- **Rebuild limpo/ASAR — NOT RUN nesta rodada.** O smoke focado passou, mas não substitui a build limpa. A resolução DNS de `github.com` continua indisponível nesta execução; a tentativa anterior de `electron-builder` terminou em `EAI_AGAIN github.com`.
- **LAN física e Windows/Linux em redes nativas — NOT RUN**, planejada para G6. O mDNS real local no WSL passou.
- **E2E audiovisual Standalone — NOT RUN.** Não há MP4 de teste aprovado em `tests/`; não usei biblioteca pessoal. Isso não é dependência funcional da infraestrutura G1.

### Estado e recomendação

As quatro correções centrais foram verificadas: cache DNS-SD próprio/limitado por interface, bind UDP multicast com filtragem, lifecycle serializado e tratamento permanente de erros WSS. Não há bloqueador técnico conhecido para G2: os contratos de identidade, pin, discovery não confiável, transporte e autorização deny-all estão disponíveis sem exigir redefinição de T1. Recomendo **SIM** para aptidão técnica de iniciar G2, sujeita à autorização separada do proprietário. Recomendo **NÃO** para homologação integral da G1 até concluir a validação Windows apropriada e a build limpa; a LAN física permanece a validação planejada de G6.

Classificação final: **G1.2 PASS; G1.3 PARTIAL; G1 tecnicamente apta para iniciar G2: SIM; G1 integralmente homologada: NÃO.** G2 não foi iniciada. A transição continua sujeita à aprovação formal da G1 pelo proprietário e à autorização separada de G2 conforme o roadmap/backlog.
