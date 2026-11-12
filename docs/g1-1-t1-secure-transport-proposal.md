# G1.1 — T1: proposta de confiança e transporte seguro

> **Estado vigente:** T1 aprovada, incluindo mínimo de 64 bits de entropia no serial X.509, mantendo `selfsigned@5.5.0`. G1.2-A–D implementadas. O browse Bonjour foi substituído pelo cache DNS-SD limitado usando `multicast-dns`, após comprovação das limitações internas de TTL, mudança de endereço e crescimento; o cache renova TTL/endpoint, é isolado por interface, consulta periodicamente e usa bind wildcard somente no socket UDP multicast com filtro de origem/subrede. Regressões determinísticas, suíte `test:unit`, harness TLS/WSS de dois processos e anúncio/busca multicast real local passam. O módulo atual foi carregado por Electron 45 dentro de ASAR após substituir o JS compilado correspondente em um pacote Linux anterior; rebuild limpo com `electron-builder` não completou por `EAI_AGAIN github.com`. Windows nativo não foi executado. A segunda revisão do Sol confirmou a correção dos achados P1/P2 sem novo defeito nesse escopo; validações ambientais e aceite final da G1 continuam pendentes. G2 não iniciada.

## Estado, escopo e evidência

**G1.1/T1 aprovada pelo proprietário em 2026-11-11; revisão pontual do serial aprovada na retomada.** `selfsigned@5.5.0` gera nove bytes criptográficos e sinal positivo, permitindo até 71 bits aleatórios após reservar o bit de sinal; o mínimo aprovado é 64. A implementação valida serial positivo/não zero, RSA-2048, assinatura SHA-256, SAN e validade; calcula SHA-256 diretamente do DER com `node:crypto` e não usa o fingerprint SHA-1 de `selfsigned`. G1.2-A–D implementadas; G1.3 permanece parcial pelas limitações de validação descritas na seção 18. G2 não iniciada. Esta proposta complementa o [contrato pareado](paired-mode-contract.md), o [plano](paired-mode-execution-plan.md) e o [ticket 0007/0001](backlog/0007-fase-g-comunicacao-remota-segura/0001-g1-infraestrutura-https-wss.md). T2 e D1–D5 não foram alterados; a Fase F permanece encerrada.

Working tree inicial: quatro configurações `.codex/agents/{architecture-explorer,code-reviewer,documentation-engineer,qa-engineer}.toml` já modificadas, preservadas. HEAD `81c5383`. A análise usa código local e documentação primária; as APIs propostas ainda exigem testes de compatibilidade na implementação.

## 1. Recomendação executiva

Servidor `node:https` HTTP/1.1 no Main do **Player**, cliente no Main da **Gestão**, com `ws` para WebSocket sobre o mesmo servidor/porta. TLS mínimo 1.2, suporte 1.3 pelo runtime, sem HTTP/WS alternativo. Certificado próprio do Player, confiança explícita por pin SHA-256 do certificado completo e âncora privada por conexão; nenhum certificado instalado no trust store do sistema. IP serve para alcançar o peer, não para provar sua identidade.

Recomenda-se TLS autenticando o Player + credencial bearer aleatória individual autenticando a Gestão, entregue/revogada por G2, em vez de mTLS inicialmente. Só um vínculo Controller autorizado e um canal de controle ativo por Player. G1 não emite credenciais ou consente pareamento: recebe um port de autorização, **deny-all por padrão**. Sem G2 não existe controle remoto de produção, nem mesmo se TLS estiver pronto. TLS, vínculo, canal conectado e autoridade operacional reconciliada são estados distintos.

Descoberta mDNS/DNS-SD IPv4 e seleção de Player pela UI conforme complemento; interface elegível selecionada com consentimento e porta sugerida `47831` configurável. IP manual apenas em Avançado. Sem wildcard TCP, redirecionamento, UPnP, relay/cloud, serviço do sistema ou privilégios administrativos novos. Socket UDP multicast tem exceção de bind própria descrita no complemento. O número é sugestão de configuração, não reserva de porta nem garantia contra conflito.

A simplicidade vem de um servidor/porta, dois adapters e bibliotecas específicas; não construir framework HTTP, PKI empresarial, parser WebSocket ou criptografia própria.

## 2. Viabilidade na base atual

| Fonte inspecionada | Fato relevante / consequência |
|---|---|
| `main.ts`, `main-runtime.ts` | Bootstrap separado do composition root real; `app.whenReady`, gates de instalação/função e shutdown já existem. Compor transporte em `main-runtime.ts`, sem serviço paralelo de inicialização |
| `src/main-management-host.ts`, `management-contracts.ts` | Aplicação única Main-side, hostEpoch/revisão e recibos IPC em memória. Não transformar esses recibos em ledger de rede nem chamar aplicação a partir de G1 |
| `src/main-media-runtime.ts`, `player-playback-contracts.ts`, `player-playback-service.ts` | Biblioteca e engine compartilhadas, tentativas/host e containment locais. G1 não acessa arquivos de mídia, não produz EOF, não altera recovery e não precisa da engine para funcionar |
| `src/main-ipc-policy.ts`, Preloads, `src/main-window-factories.ts` | Verificação de WebContents/frame/documento e isolamento já estabelecidos. Mantê-los; nenhum socket, chave, token, TLS option ou URL arbitrária exposto ao Renderer |
| `package.json`, `package-lock.json`, `tsconfig.json` | Electron 45.0.0 no lock, TS CommonJS/ES2022, tipos Node 24, mínimo Node de desenvolvimento >=22.12. Sem dependências runtime declaradas e sem `ws`/`selfsigned` no lock consultado. Precisam virar dependências de produção explícitas, não usar transitiva do Playwright |
| Documentos Windows/CI | Reutilizar runner oficial e checkout NTFS, perfis isolados; PR validation e publicação são caminhos distintos |

Consultar `process.versions` no Electron efetivamente usado nos futuros testes; versão de Node do shell/tipos não prova API do Node embutido. Nenhuma execução do Electron foi necessária nesta análise. O contrato de build deve verificar inclusão das novas dependências no pacote sem antecipar publicação/instalação.

## 3. Alternativas e decisão proposta

| Alternativa | Segurança / operação / manutenção | Recomendação |
|---|---|---|
| HTTP/WS na LAN ou TLS com qualquer certificado aceito | IP/SSID não impede MITM, roubo de segredo e injeção; simplicidade aparente elimina autenticidade | Rejeitar |
| Certificado público/ACME | Boa validação web, mas exige DNS/domínio, renovação/conectividade e distribuição que não combinam com LAN offline | Não exigir |
| CA própria + mTLS | Autenticação forte de ambos; exige emissão de certificados cliente, ciclo de CA/CRL, renovação e recuperação de ambos os lados | Alternativa futura se threat model exigir; não necessária para um Controller local |
| Certificado próprio pinado + bearer de 256 bits em TLS | Confiança explícita do servidor, cliente por segredo revogável; menor gestão de certificados. Roubo do token permite impersonação do Controller | **Escolha proposta**, com proteção de segredos e revogação G2 |
| TOFU silencioso/código curto sem protocolo autenticado | Primeiro acesso pode fixar atacante; código numérico sozinho não autentica TLS | Rejeitar; comparar pin fora do canal antes de enviar credencial |
| Pin SPKI com renovação automática | Evita re-pair ao trocar certificado da mesma chave, mas exige autenticar distribuição da nova âncora, expiração e rollback | Adiar; pin exato e manutenção explícita são mais simples na primeira versão |
| mDNS/DNS-SD | Facilita descoberta sem internet; anúncio é não confiável e multicast pode estar bloqueado | Escolhido na revisão LAN; scan/broadcast proprietário rejeitados; manual só Avançado |
| `electron.net`/WebSocket do Renderer | Mistura cookies, session/proxy/validação Chromium e UI com chaves; servidor WSS ainda precisa de biblioteca | Usar `node:https`/`ws` no Main, agentes privados |
| OpenSSL CLI, certificados embarcados ou gerador X.509 próprio | CLI não garantido no Windows; chave embarcada seria compartilhada; ASN.1/PKI próprio amplia risco | Rejeitar |

`ws` e gerador X.509 permanecem propostos; a revisão LAN acrescenta biblioteca de descoberta em G1 e PAKE de biblioteca em G2, conforme complemento (sem instalação nesta rodada). Escolha do gerador: `selfsigned` com API assíncrona, RSA-2048/SHA-256 explícitos e extensões controladas. A versão 5 mudou API e dependências; fixar release compatível no lock, revisar licença/transitivas e interoperabilidade CJS/Electron no lote G1.2. Não copiar exemplos antigos com SHA-1 ou opções removidas. Sem dependência nativa opcional de aceleração WebSocket na primeira versão. Se a versão escolhida exigir outra arquitetura/API, registrar incompatibilidade antes de trocar tecnologia, não substituir silenciosamente.

## 4. Threat model

| Ameaça realista | Proteção proposta | Limite residual |
|---|---|---|
| Cliente/funcionário em Wi-Fi compartilhado; ARP/DNS/IP spoofing | TLS, âncora exclusiva, pin exato e identidade SAN estável; nenhuma credencial antes da confiança | Atacante ainda pode derrubar/reter pacotes; comparar pin errado continua risco humano |
| Página maliciosa no navegador acessando serviço LAN | Nenhum CORS permissivo/cookie; rejeitar Origin presente, inclusive `null`, e Upgrade não autenticado | Cliente nativo malicioso pode omitir Origin: autenticação continua obrigatória |
| Peer não autorizado, segundo Controller, token revogado | G2 fornece autorização/vínculo único; gate antes de Upgrade e a cada dispatch; revogação fecha canal | Segredo roubado tem poder até revogação; ID público não autentica |
| Flood TLS/HTTP/WS, slowloris, payload fragmentado, consumidor lento | Tetos globais/IP, prazos, limites por byte/mensagem/fila, sem compressão e rate limits | Main não é proteção DDoS; firewall/rede segmentada continuam relevantes |
| XSS/Renderer comprometido | Preload restrito, sender/frame/documento, sem APIs genéricas ou segredos | Renderer autorizado pode pedir ações permitidas; Main valida domínio depois |
| Crash, disco cheio, secret store bloqueado | Identidade persistida atomicamente antes de ativar; erro impede rede; sem regeneração silenciosa | G3/G4, não TLS, resolvem resultado de comando incerto |
| Usuário local malicioso, malware/admin/roubo de conta | safeStorage e permissões restritas por conta | Não promete proteção contra código na mesma conta, admin ou memória do processo |
| Clone de perfil/restauração antiga/credenciais copiadas | Mesmo ID não é identidade nova; conflito exige reset/re-pair e fences G2/G4 | Exclusividade física e anti-rollback de backup não são fornecidos por pinning |
| Dependência vulnerável, relógio errado, regra de firewall pública | Lock/revisão de dependências, validade TLS fail-closed, interface e firewall explícitos | Offline não permite garantir consulta de advisories ou perfil de rede pelo Node |

Não transmitir vídeo, catálogo completo, SQLite, caminhos de acervo, licença ou dados administrativos em health/discovery. G3 define mensagens e H os dados operacionais mínimos.

## 5. Identidade, certificado e confiança

### 5.1 Identidade por perfil e criação futura

`deviceId` e `controllerId`: UUIDs aleatórios persistentes por perfil/conta, independentes de IP, nome visível, instalação, hostEpoch e controlEpoch. Respeitar userData por conta e função global existentes; não criar autoridade em ProgramData nem alterar E3. Outro usuário Windows não herda chaves/vínculo; precisa de configuração própria e a exclusividade instalada existente continua valendo.

Player: gerar chave RSA-2048, certificado autoassinado SHA-256, serial positivo/não zero e pelo menos 64 bits de entropia criptográfica, validade 365 dias (início com tolerância máxima de 5 min), SAN DNS `player-<deviceId>.karaoke.invalid`, EKU serverAuth, keyUsage digitalSignature/keyEncipherment e basicConstraints CA=false. O pacote `selfsigned@5.5.0` gera 9 bytes com `crypto.getRandomValues` e converte o valor para positivo, preservando 71 bits aleatórios; o serial não é credencial de autenticação. Identidade e confiança dependem de TLS validado, pin SHA-256 e autorização G2. Verificar com `crypto.X509Certificate` a correspondência chave/certificado, serial positivo/não zero, assinatura, validade, algoritmo e SAN antes de persistir/usar. Calcular pin com `createHash('sha256').update(certificate.raw)`; nunca usar `GenerateResult.fingerprint` (SHA-1). Não confiar em defaults criptográficos do gerador. G1.2 deve comprovar leaf autoassinado confiado explicitamente no Node/Electron escolhido; falha de interoperabilidade é bloqueador técnico, não motivo para relaxar TLS.

Persistir bundle de identidade de forma atômica no userData, com metadados públicos e chave cifrada; falha não publica nova identidade. Não regenerar chave/ID por erro de leitura/descriptografia. Reset é explícito e exige novo pairing; não apaga journal/SQLite. Não exportar chave privada nem instalar CA no Windows/Linux.

### 5.2 Pinning para endereços variáveis

Registro de confiança Gestão: deviceId esperado, certificado PEM público exato, SHA-256 DER, nome SAN esperado e endpoint privado escolhido. Conectar ao IP real com `servername` definido pelo SAN confiado; não usar valor apresentado pelo peer para definir quem ele deveria ser. `https.Agent` privado usa **apenas** esse certificado em `ca`, `rejectUnauthorized:true` e `checkServerIdentity` que chama a validação normal contra SAN e verifica hash DER exato. Sem CAs públicas suplementares, sem globalAgent, sem cookies/proxy implícito e sem `NODE_TLS_REJECT_UNAUTHORIZED=0`. `ws` usa a mesma política TLS do cliente HTTPS.

Desabilitar cache de sessões TLS no cliente inicialmente (`maxCachedSessions:0` e sem reutilização de sessões no adapter WS), para que reconexões não pulem validação de certificado. Não habilitar TLS early data. Mudança de IP não altera trust; mudança de certificado ou SAN bloqueia antes de enviar Authorization, mesmo com mesmo nome/UUID. Redirecionamentos HTTP/WS são recusados, nunca seguir levando bearer.

### 5.3 Bootstrap e interface G1/G2 — substituído pela revisão LAN

O [complemento LAN](g1-1-t1-lan-pairing.md), §2–§4, é a especificação vigente: mDNS só descobre; canal bootstrap estritamente limitado leva SRP-6a com consentimento bilateral e código efêmero de oito dígitos. Após provas/binding autenticado do certificado, G2 persiste trust/credencial; operações passam a usar TLS pinado estrito e bearer. Código curto fora do PAKE não autentica. Arquivos, QR e comparação de fingerprint não integram mais o fluxo comum. Não é correto reutilizar bearer antigo no canal provisório.

G1 oferece ports/limites e default deny-all; G2 faz o fluxo criptográfico/consentimento. O perfil e binding exigem revisão/vetores G2.1 antes da implementação de pairing de produção; não inventar PAKE ou liberar controle pelo clique em anúncio.

### 5.4 Renovação, revogação e rotação

Primeira versão: manutenção explícita, aviso local a 30 dias do vencimento; sem renovação invisível. Rotacionar certificado/chave invalida o pin, requer confirmação/re-pair G2 e revogação das credenciais anteriores; sem confiar em certificado novo enviado em canal não autenticado. Não trocar certificado durante vez ativa como efeito colateral: H/G4 mantêm execução local e planejam manutenção segura; rede não controla playback.

Expirado/relógio inválido: bloquear novas conexões e encerrar canal no deadline de validade; sinalizar erro local, sem bypass. Contenção local da vez permanece independente. Perda/comprometimento de chave ou token: aplicar a revogação durável descrita em §5.6. Bloqueio imediato em memória protege a sessão corrente, mas sucesso só é declarado depois da gravação confirmada; ele não basta para garantir revogação após restart. Limpeza/rotação do token não apaga evidências G3. Não implementar listas CRL/OCSP ou CA externa nesta versão.

### 5.5 Experiência do operador e renovação — revisão LAN

Manter certificado de 365 dias e avisos 30/7 dias. Fluxo atual: abrir Gestão → ícone Dispositivos ao lado do sino → selecionar Player encontrado → aceitar no Player → digitar na Gestão o código mostrado no Player → confirmação criptográfica/persistência → reconciliação. Após reinício/queda com vínculo válido não pedir código de novo. Offline explícito continua exigindo retorno operacional explícito.

Renovação usa a mesma experiência na UI, inclusive após vencimento, com geração **localmente autorizada** de certificado novo válido e PAKE no canal restrito de recuperação. Certificado vencido não é aceito pelo adapter operacional, e mDNS não concede confiança ao novo pin. Troca/perda de aparelho exige retirada explícita/durável do vínculo anterior e novo consentimento; journal/fila/perfis não são importados ou apagados. Detalhes e narrativa no complemento. O fluxo de arquivo/QR da revisão anterior foi substituído por decisão explícita do proprietário; não é um pré-requisito pendente de UX.

### 5.6 Revogação durável simples — responsabilidade G2

**Problema corrigido:** revogar somente em memória e falhar ao gravar poderia reautorizar o token antigo no próximo startup. Registrar “erro” na UI evita falso sucesso, mas não resolve essa lacuna sozinho. G2 deve persistir o estado antes de confirmar e carregar esse mesmo estado antes de abrir admissão no restart.

**Escolha proposta:** um pequeno arquivo de estado de autorização por perfil, por exemplo `remote-authorization.json`, com schemaVersion, revision/credentialGeneration e o único vínculo ativo (controllerId e hash do token) ou `activeBinding: null`. Não guardar token do Controller em claro no Player; segredo cliente segue no bundle cifrado da Gestão. Nada exige banco novo, histórico de auditoria ou serviço externo. Não colocar dados em installation manifest/SQLite operacional nem reutilizar inventário descartável. O writer fica no módulo de pairing G2, com um único dono e serialização; G1 só consome o port.

Procedimento:

1. Serializar revogação/novo pairing. Invalidar imediatamente admissões do vínculo alvo em memória, fechar conexão dele e cercar callbacks em andamento. Isso é proteção provisória, não sucesso durável.
2. Ler último estado confirmado, preparar candidato com geração incrementada e vínculo removido. Gravar arquivo temporário exclusivo no mesmo diretório, sincronizar conteúdo e substituir atomicamente; confirmar resultado pela releitura validada. Usar padrões locais de escrita durável existentes como referência, sem compartilhar instância/store com instalação ou recovery.
3. Só após confirmação publicar geração persistida e informar **Vínculo removido**. Retry consulta estado/revisão: se a substituição ocorreu mas resposta falhou, confirmar pela leitura antes de repetir. Não gerar token novo até confirmar retirada do antigo.
4. No startup, ler/validar estado antes de rede. Estado revogado não autoriza token antigo. Arquivo ausente permite apenas onboarding sem controlador autorizado; corrompido/ilegível bloqueia remoto, sem restaurar automaticamente backup de autorização antiga. Sem varrer logs para decidir vínculo.
5. Falha antes de persistir: manter remoto bloqueado **no processo corrente**, informar claramente **Não foi possível salvar a remoção; vínculo ainda não removido de forma permanente**, e oferecer tentar novamente após reparar disco/permissões. Não afirmar “revogado”, não autorizar novo pairing e não prometer que restart preserve uma decisão que o disco não aceitou. Se houver incerteza após rename, consultar o estado; sem prova, manter bloqueio e falha visível.

Garantia delimitada: **uma revogação confirmada** não reautoriza o Controller após restart normal. Se nenhuma escrita puder ser persistida e houver crash antes da confirmação, o estado antigo pode sobreviver; impedir isso absolutamente exigiria outra autoridade durável. Não adicionar infraestrutura para ocultar essa impossibilidade. Para incidente de credencial com disco sem escrita, orientar manter remoto desabilitado/Player desconectado até concluir reparo e revogação; não apresentar bloqueio em RAM como solução durável. Também não prometer resistência a restauração manual de backup antigo ou ataque de administrador.

Atomicidade de replace e durabilidade precisam de prova Windows/Linux nos testes G2. Sincronização de diretório onde suportada; se plataforma não oferecer a mesma barreira, documentar limite de perda de energia, não mascarar erro. Operação de arquivo não é transação distribuída entre Gestão e Player: confirmação de revogação pertence ao estado persistido no Player; UI Gestão consulta resultado e não presume sucesso pelo fechamento do socket. Comandos já aceitos seguem G3/G4, sem rollback de efeito físico inventado.

## 6. Segredos Windows/Linux — revisão da versão fixada

**Verificado por inspeção:** pacote instalado e lock usam Electron **45.0.0**; `node_modules/electron/electron.d.ts` declara `isAsyncEncryptionAvailable(): Promise<boolean>`, `encryptStringAsync(): Promise<Buffer>` e `decryptStringAsync(): Promise<{result, shouldReEncrypt}>`. A última **não retorna string diretamente**. Conferidos também documentação e binding oficiais da tag v45.0.0; nenhuma execução Electron nesta rodada.

**Ressalva de segurança:** `getSelectedStorageBackend()` descreve a seleção Linux do caminho legado; não é introspecção do provider assíncrono. O binding assíncrono marca disponibilidade ao obter encryptor, e a documentação admite fallback. Portanto `isAsyncEncryptionAvailable() === true` + sucesso de round-trip **não provam**, sozinhos, uso de cofre seguro Linux. Não combinar o nome de um backend legado com uma suposição sobre outro provider.

Escolha de menor complexidade para esta versão:

- **Windows:** API assíncrona nativa depois de `app.whenReady`, proteção DPAPI por usuário; tratar Promise rejeitada/indisponibilidade e `result`. Se `shouldReEncrypt`, recifrar o resultado com a API nativa e substituir o blob atomicamente antes de publicar atualização do bundle. Não criar gerenciador de rotação de chaves próprio.
- **Linux/Electron 45:** caminho conservador com o `safeStorage` nativo **síncrono** para os poucos segredos, somente se `isEncryptionAvailable()` e backend conhecido de cofre (`gnome_libsecret`, `kwallet`, `kwallet5` ou `kwallet6`). Recusar `basic_text`, `unknown` e backend inesperado. Assim a verificação e encrypt/decrypt usam o mesmo caminho documentado. Essa exceção é intencional: a API síncrona está depreciada e remover-se-á no Electron 46; não atualizar Electron sem revisar este gate. Não adotar secret manager externo só para evitar essa limitação.
- Inicialização síncrona Linux pode pedir desbloqueio e bloquear Main. Executar provisionamento/unlock por ação explícita e fora de playback ativo; não chamar por frame/tick nem inicializar cofre no caminho crítico do Player independente. Se não for possível assegurar disponibilidade sem prejudicar operação local, deixar remoto desabilitado nessa configuração. A alternativa compatível e segura é indisponibilidade remota, não thread/processo/serviço de segredos novo nesta fase.
- Linux sem cofre seguro: **remoto desabilitado, local preservado**, sem token/chave em claro, base64 ou senha fixa. Não usar `setUsePlainTextEncryption`. No futuro, async Linux pode substituir essa exceção quando houver verificação suportada do provider seguro; não fazer isso por prefixo de ciphertext, heurística ou mera presença de D-Bus.

Um adapter pequeno `SecretProtector` no runtime Main normaliza resultado/erro para testes; não exige arquivo/package novo, múltiplos provedores próprios ou dependência adicional. Ciphertext/bundle validado permanece em userData privado; Windows não compartilha blobs entre contas. Chave/token corrompido não dispara nova identidade. APIs podem falhar mesmo depois do gate; rejeitar operação dependente, manter evidência e não publicar sucesso.

Proteção por sistema não protege contra código da mesma conta ou administrador; JavaScript não garante apagar todas as cópias de segredo da RAM. Sem segredo no Renderer, log ou nuvem. Testes reais Linux/Windows continuam necessários; disponibilidade de tipos/API não prova funcionamento do cofre na máquina final.

## 7. Endereço, bind e recursos

- IPv4 local inicialmente (descoberta automática como caminho normal; IP manual em Avançado): endpoint aceita IP privado RFC1918 literal e porta 1024–65535; loopback só em harness isolado. Rejeitar URL com credenciais/path/query/fragmento, DNS arbitrário, multicast, broadcast, unspecified, link-local e endereço público. IPv6 continua fora da primeira versão; mDNS/DNS-SD entra explicitamente conforme revisão LAN, sem autorizar o peer.
- Player seleciona interface pelo snapshot de `os.networkInterfaces`: única elegível com consentimento de rede, ou escolha simples pelo nome quando ambígua. RFC1918 não prova que interface é confiável: VPN/guest também podem usá-lo. Nunca inferir segurança pelo range. Não bind em `0.0.0.0`/`::`, não escolher outra interface em fallback.
- Porta em uso ou IP removido: erro tipado e estado indisponível, sem porta/interface aleatória. Mudança DHCP invalida endpoint antigo; descoberta fornece novos candidatos e G4 só confirma novo endpoint após TLS/autenticação da identidade salva. Não escanear sub-rede nem trocar pin pelo anúncio. Reserva DHCP é orientação operacional opcional, não dependência do software.
- Firewall: nenhuma alteração automática. Operador pode precisar autorizar o executável/porta numa rede privada; instruções devem limitar interface/sub-rede e perfil. Bind privado sozinho **não garante** perfil Windows privado. Se não houver regra adequada, mostrar inacessibilidade; não exigir admin na execução normal. Descoberta automática e UDP multicast estão agora propostas explicitamente; alterações de firewall continuam exigindo autorização própria.
- Sem listeners em Combined enquanto apenas Gestão remota; H8 não abre servidor por arrasto. Nenhum listener por padrão em Player independente: habilitação explícita e configuração válidas, safeStorage pronto e port G2 disponível são necessários.

Valores iniciais propostos, constantes testáveis, sem serem timeouts das operações de negócio:

| Recurso | Limite proposto / ação |
|---|---|
| TCP/handshakes simultâneos | 16 globais, 4/IP; acima fechar antes de parsing caro; tabela IP limitada a 128 entradas, não crescimento ilimitado |
| Handshake TLS / headers / autorização port | 5 s cada; timeout fecha socket; port assíncrono com cancelamento e fence após await |
| HTTP | 8 KiB headers, 32 headers, body 16 KiB, request 10 s, keepalive 5 s; sem bodies em GET, sem pipelining ilimitado |
| WSS | Uma conexão de controle ativa; reserva atômica do slot antes do Upgrade; concorrente recebe busy, nunca expulsa vínculo ativo silenciosamente |
| Frames | JSON UTF-8 texto, mensagem remontada <=64 KiB, sem binário/compressão; budget de fragmentos/bytes/tempo, validação UTF-8 mantida |
| Frequência | Pré-auth 10 solicitações/min/IP e 60 globais/min; canal autenticado 20 mensagens/s, burst 40; excedente fecha com código estável |
| Saída | <=256 KiB buffered e <=64 mensagens pendentes; peer lento fecha, sem fila volátil ilimitada nem descarte silencioso de evento durável |
| Heartbeat | ping a cada 15 s, pong esperado em 10 s; ausência encerra somente transporte. Não prova EOF/cancelamento |
| Negociação G1 | 5 s para hello/ready de transporte, sem heartbeat reiniciar esse prazo |
| Close | Até 2 s de handshake WS e 3 s total para teardown; depois terminar sockets conhecidos, nunca esperar indefinite |

Rate limit usa relógio monotônico e limita metadados de controle, não retém IDs de negócio. Compressão desabilitada nos dois lados. Tetos globais são necessários porque origem IP pode mudar; não aceitar `X-Forwarded-For`. G3 precisa paginar snapshot/replay para caber, não aumentar silenciosamente limite para transmitir fila/catalogão.

## 8. Handshake, rotas e fronteiras

Fluxo operacional futuro (após bootstrap PAKE do complemento): consentimento de rede → descoberta/seleção ou identidade salva → disponibilidade de segredos → bind Player → Gestão conecta TLS estrito ao pin → Authorization bearer → G2 valida vínculo/escopo/geração → reserva slot/Upgrade WSS → negociação G1 → G3 HELLO/snapshot/replay → G4 reconciliação → H libera ação operacional segura. Só os mecanismos G1 são implementáveis em G1.2/G1.3.

- `GET /v1/control` via Upgrade: autenticação e limites antes de `ws.handleUpgrade`; aceitar somente subprotocol `kq-transport.v1`, sem cookie/Origin. G1 não aceita conexão sem G2 em produção.
- HTTPS aceita somente handlers explicitamente registrados por G2/G3 e autorizados pelo port; inicialmente nenhum endpoint de inventário, health identificável, mídia ou operação. G3 poderá consultar mídia por HTTPS paginado; comandos/status/eventos permanecem WSS, sem API duplicada HTTP.
- Negociação G1: objeto fechado `{type: transport-hello, transportVersion: 1, capabilities: [...]}` e `transport-ready` com capacidades técnicas suportadas, sem sessão/fila/playback; máximo 16 capabilities de 32 caracteres. Versão major desconhecida recusa. Capacidade extra não concede permissão. Dispositivo/Controller autenticados vêm do port, não do ID declarado no frame. Schemas operacionais versionados e seus epochs são de G3.
- Handlers recebem peer/connectionId opacos criados Main-side. Nenhum cliente pode construir contexto autorizado enviando JSON com `authorized:true`.
- Validar método/path exatos, Content-Type e body/JSON com campos permitidos, limites de string/lista/profundidade; rejeitar headers de auth duplicados/ambíguos, Upgrade malformado, query com segredo, rota desconhecida e URLs absolutas. Sem templates dinâmicos, execução de comando, eval ou passagem de objetos arbitrários para opções TLS/FS.
- Rejeitar Origin quando presente, inclusive `null`; clientes Node oficiais o omitem. Não implementar CORS liberado para permitir Renderer. Origin é proteção adicional, nunca substitui token. Não alterar CSP ou validação global de certificados Electron.
- Revalidar autorização/geração antes de entregar cada mensagem ao port superior; revogação concorrente com auth await ou Upgrade tem fence. Liberação do slot usa connectionId para fechamento antigo não liberar canal novo. G1 garante isso, não deduplica comandos. Revogação bloqueia novas admissões/dispatches; não prova que mensagem já entregue ao port não teve efeito. G3/H devem validar geração no ponto de admissão serializado e reconciliar operações já aceitas, sem rollback inventado.
- Erros sanitizados: TLS_TRUST_FAILED, CERT_EXPIRED, SECRET_STORAGE_UNAVAILABLE, BIND_UNAVAILABLE, AUTH_REQUIRED/NOT_AUTHORIZED, CONNECTION_BUSY, VERSION_UNSUPPORTED, INVALID_MESSAGE, LIMIT_EXCEEDED, TRANSPORT_CLOSED. Para não autenticado, resposta genérica sem dizer se controllerId existe. Logs só código/correlationId técnico, estado e contadores agregados; IP/hostname não logados por padrão.
- G1 só confirma entrega ao socket local, nunca aceitação/conclusão da operação. Falha após envio vira transporte encerrado, **não** NOT_SENT comprovado. G3/G4 preservam operationId original e resultado desconhecido.

## 9. Módulos e ports propostos

Manter estrutura plana de `src/`, sem diretórios/abstrações globais novos. Novos módulos têm responsabilidades separadas necessárias:

| Novo arquivo proposto | Responsabilidade |
|---|---|
| `src/remote-transport-contracts.ts` | Tipos/configuração/limites/erros/ports; nenhuma importação Electron/engine/SQLite |
| `src/remote-identity-store.ts` | Bundle por conta, validação, geração via provider e persistência atômica com SecretProtector injetável; nunca decisão de pairing |
| `src/remote-tls-policy.ts` | SAN/pin/âncora exclusiva, agentes privados e validação de endpoint/certificado; sem fetch genérico |
| `src/remote-transport.ts` | Fábricas de servidor Player e cliente Gestão, Upgrade/limites/slot/lifecycle; usa contratos, não domínio |
| `src/remote-discovery.ts` | Anúncio/browse e cache limitados por interface; candidatos não autorizados, sem dependência G2/engine |
| `src/main-remote-runtime.ts` | Composição mínima Electron/safeStorage/config, autorização e eventos sanitizados; integração explícita com shutdown |

Ports mínimos, especificação documental (nomes ainda não implementados):

- `SecretProtector`: disponibilidade segura e encrypt/decrypt normalizados por Promise para o consumidor; Windows usa API async, Linux/Electron 45 usa a exceção sync de §6 (Promise não a torna não bloqueante). Sem fallback claro; só Main recebe instância Electron.
- `IdentityProvider`: carregar/criar explicitamente identidade; retorno privado restrito ao transport runtime. Proibição de criação automática por falha.
- `RemoteAuthorizationPort`: `authorize(requestMetadata, abortSignal)` retorna denied ou peer opaco `{controllerId, deviceId, credentialGeneration, permissions}`; `isCurrent(peer)` e subscrição de revogação. Default deny-all. G2 implementa armazenamento, consentimento, token e vínculo único; G1 implementa chamadas e fences.
- `TransportChannel`: connectionId/peer imutáveis, send bounded, message callback, state/error/close e dispose assíncrono idempotente. Callback recebe somente mensagem limitada/validada e contexto; G3 valida schema de domínio antes de agir. Resultado send não é ACK de negócio.
- `TransportRoutePort`: handlers HTTPS registrados por método/path/escopo e limite <= teto G1; ausente = negar. G2/G3 fornecem handlers no composition root, sem importação invertida em G1.

Dependências: identidade/TLS/transport → contratos; main-remote-runtime → fábricas e adapters injetados. G2 implementa AuthorizationPort, G3 consome TransportChannel, G4 reage aos eventos de conexão. main-runtime compõe. Nenhum módulo G1 importa G2/G3/G4/H nem executa comando Management. G1.2 usa deny-all e bootstrap sem handler G2; a factory de bootstrap isolada não recebe credenciais operacionais. Testes podem injetar port sintético autorizado, inacessível por env/flag de produção.

Não adicionar IPC/controles remotos visíveis nesta fase: G2/G5 integram UI com canais específicos e `createMainIpcPolicy`. Configuração futura aceita DTO estreito, não socket ou caminho arbitrário. Em testes de integração G1 usar composição isolada, sem novo launcher de produto.

## 10. Lifecycle e shutdown

Estados de transporte: disabled → starting → listening/connecting → negotiating → transport-ready → closing → disabled/error. `transport-ready` não significa pareado operacional ou reconciliado. start/close concorrentes coalescem; um generation token impede callback antigo de publicar connected após close. Erro de bind/liberação deve ser observado, sem retry infinito.

Em G1 sem port G2, o runtime de produção fica disabled; fixtures G1 podem exercitar listener TLS/deny-all. Após G2, operador habilita rede e estado de configuração pode ser salvo por conta; restart só tenta interface/endereço previamente escolhidos com identidade válida. Não depender de janela Renderer aberta nem recriar listener por subscription.

Desconectar/fechar transporte não chama Stop, dispose da engine, conclusão ou limpeza de fila/journal. O shutdown real começa por decisão local existente; só depois de autorização de saída fechar novas admissões, cancelar handlers, drenar escrita de socket limitada, WS close, terminar conexões TLS/HTTP/WS rastreadas e destruir agentes/timers/listeners. Não fechar rede ao abrir modal de saída que ainda pode ser cancelado. Não confiar só em `https.Server.close` para sockets upgraded nem só em `will-quit` para async; integrar ao drain anterior ao quit existente. Não adicionar app.quit recursivo concorrente aos coordenadores atuais.

G1 oferece descoberta/canal com uma tentativa de conexão cancelável e heartbeat; tentativas de reconnect/backoff pertencem G4. Reconnect não transfere autoridade e heartbeat timeout não resolve operação pendente. Suspensão de computador/rede perdida gera evento técnico, nunca EOF.

## 11. Decomposição G1.2/G1.3 — após aprovação e autorização

| Lote futuro | Arquivos/responsabilidade | Entrega e critério de conclusão |
|---|---|---|
| G1.2-A | contratos, dependências runtime e identidade/store | Tipos/limites; lock com pacotes revisados; geração e secret adapter em perfis de teste; escrita atômica e fail-closed; CJS/Electron compatível. Nenhum listener de produto |
| G1.2-B | TLS policy/cliente e servidor em remote-transport | Certificado pinado/SAN/validade, TLS1.2+, bind explícito; testes com fixtures; auth deny-all sem G2; nenhuma credencial real |
| G1.2-C | Upgrade/negociação/ports e limites | Auth antes de upgrade, slot único, geração/revogação, transport-hello, quotas/backpressure/close; sem schema/ACK operacional G3 |
| G1.2-D | main-remote-runtime e integração mínima de lifecycle | Produção disabled sem G2; safeStorage depois de ready; shutdown anterior ao quit e sem ação em playback. Compilar/validar pack de dependências quando afetado, sem instalação/publicação |
| G1.3-A | testes focados e revisão de segurança | Matriz abaixo em unitários, cache DNS-SD e loopback; sem bypass de certificado/autorização embutido em produção |
| G1.3-B | Electron real/Linux e runner Windows | Secret store real e caminho específico por plataforma, disponível/indisponível, cleanup, IPC/Renderer e smoke de carregamento dos módulos em pacote quando viável; evidências por snapshot |
| G1.3-C | revisão final/documentação | Corrigir problemas comprovados, rever diff e aceites; registrar NOT RUN e limitar alegações. Proprietário decide aprovação G1; não iniciar G2 automaticamente |

A a D são subdivisões de G1.2; A a C de G1.3, sem novos IDs canônicos. Cada lote somente sob autorização da subetapa; sem autonomia implícita entre etapas. G1.3 não homologa pairing G2, replay G3/G4, LAN duas máquinas G6 ou operação H5.

## 12. Matriz de testes planejada

| Grupo | Testes/oráculo | Ambiente futuro |
|---|---|---|
| T1-ID | Bundle íntegro/chave correspondente, tampering/truncamento, falha rename/gravação, restart, arquivo ausente vs corrompido; não regenerar silenciosamente | Unitário/FS isolado Linux/Windows |
| T1-SECRET | Windows async retorna objeto; Linux sync com backend conhecido e API disponível; basic_text/unknown/fallback async não aprovam cofre; falha de decrypt/re-encrypt/unlock bloqueia remoto e preserva local; upgrade Electron 46 tem gate | Mocks determinísticos + Electron real por plataforma |
| T1-TLS | Cert correto; outra chave/cert com mesmo UUID/SAN; expirado/futuro/SAN errado; CA pública não basta; IP novo mesma identidade; TLS antigo recusado; zero Authorization enviado antes da validação | Loopback Node e Node embutido Electron; certs fixture/test-only |
| T1-BOOT | G1 sem handler G2 útil; G2 testa SRP/código errado, anúncios falsos, MITM/binding TLS, consentimento/cancelamento/timeout/quota e recuperação anual sem aceitar certificado vencido operacionalmente | Inspeção/negativos G1; fluxo humano/E2E G2 |
| T1-AUTH | deny-all default, token ausente/inválido/revogado via port fake, header duplicado, Origin web/null, scope negado, duas conexões/Upgrade simultâneos; zero dispatch indevido | Integração HTTPS/WSS isolada |
| T1-REVOKE | G2: revogação confirmada + restart rejeita token antigo; falhas antes/depois de sync/replace/releitura não geram falso sucesso; retry reconcilia estado; corrupto bloqueia; auth/novo pairing/close concorrentes não reativam vínculo | Unitário/FS real isolado Windows/Linux em G2; G1 testa port fake |
| T1-FENCE | Auth aguardando×revoke/close; socket antigo fechando×novo; credencial mudou antes de dispatch; start×close; sem liberar slot errado | Barreiras/abort determinísticos, sem sleeps arbitrários |
| T1-INPUT | Versão major errada, JSON inválido/profundidade/UTF-8/binário, frames fragmentados até exceder teto, body/headers/rota/método inválidos, payload com segredo em query | Unitário e rede sintética/loopback |
| T1-LIMIT | TLS lento, headers lentos, consumidor sem leitura, fila/backpressure, excesso de conexões/IP/rate/fragmentos, callbacks atrasados; limites fecham sem crescimento ilimitado | Relógio controlado + sockets de teste |
| T1-LIFE | EADDRINUSE/IP removido, disconnect/mudança de rede, timeout heartbeat, shutdown idempotente com WS upgraded/HTTP keepalive; nenhum processo/timer/socket residual, nenhuma chamada engine Stop/EOF | Integração/Electron Linux e Windows oficial |
| T1-BOUNDARY | Preload sem segredo/Node/URL genérica; sender errado/frame/Renderer externo negados; importar G1 não inicia listener; Combined não abre servidor Player | Unitário/IPC/Electron focado |
| T1-PACK | ws/gerador/transitivas runtime carregam no ASAR; nenhuma chave fixture/segredo incluído; APIs compatíveis Electron fixado e Node suportado | Verificador/smoke pacote isolado, quando aplicável/autorizado |

CI futuro reutiliza unitários e E2E existentes, sem criar workflow por arrasto. G1.3 acrescenta seleção focada ao runner oficial quando autorizada; Windows a partir do checkout NTFS, nunca source WSL. Evidência Linux não é PASS Windows. Teste de dois processos loopback não é campanha G6 em dois computadores. Nesta análise todos os testes de aplicação/compile/Electron/Windows são **NOT RUN** por restrição explícita; somente revisão documental/links/diff.

## 13. Revisão crítica e riscos remanescentes

- Confiança inicial depende de PAKE validado e consentimento/código no Player correto; não existe autenticação automática segura por IP. A UI G2 precisa referência aprovada antes de implementar; esta etapa não modifica Doop.
- O pin exato e expiração anual favorecem verificabilidade, mas impõem manutenção/re-pair. Aceitar isso é decisão do proprietário, não detalhe escondido do implementador.
- Recusar Linux sem secret store reduz disponibilidade remota, preservando confidencialidade e Standalone local. Não inventar fallback efêmero ou em claro.
- RFC1918/interface consentida reduz exposição acidental, não prova isolamento. LAN pública/guest/VPN continua ameaça. Node não certifica perfil Windows privado; não prometer enforcement de firewall sem mecanismo nativo autorizado.
- Bibliotecas/API atuais foram consultadas; não executadas no Electron deste projeto. Interop do autoassinado, CJS, safeStorage por plataforma e fechamento upgraded são gates técnicos de teste, sem relaxar controles se falharem.
- TLS e auth não tornam comando idempotente, não protegem journal de rollback e não resolvem takeover. G3/G4/H mantêm essas responsabilidades; T2 e destino final D2 seguem pendentes.
- Quotas são valores iniciais propostos; dimensionar mensagens G3 por paginação. Não elevar limites/timeouts para mascarar falha sem revisar evidência.

## 14. Aprovação T1 e execução autorizada

A proposta foi aprovada pelo proprietário em 2026-11-11 e G1.2/G1.3 foram autorizadas, sem autorizar G2. O conjunto inclui TLS pinado + bearer G2, mDNS/DNS-SD não autenticado, bootstrap SRP-6a com binding e consentimento bilateral, código de oito dígitos, reconexão automática de transporte sem reassumir offline, recuperação anual pela UI, cofre nativo/fail-closed e limites/dependências. Na retomada, o proprietário aprovou o mínimo de 64 bits de entropia para o serial X.509, mantendo `selfsigned@5.5.0`; a justificativa e validações adicionais estão registradas acima. O complemento mantém o gate técnico G2.1 de biblioteca/perfil/encoding/binding; esse wire contract ainda não está validado e não deve ser tratado como protocolo auditado pronto para produção. G2 permanece não iniciada.

T1/G1.2/G1.3 não autorizam G2, instalação de certificados reais, alteração de firewall, publicação ou alteração de comportamento operacional. A implementação deve obedecer aos ports/aceites e parar quando a dependência não satisfizer o contrato.

## 15. Fontes primárias e alcance

Consultadas nesta análise para confirmar capacidades das APIs, sem executar comandos de exemplos externos:

- [Electron 45.0.0 safeStorage](https://raw.githubusercontent.com/electron/electron/v45.0.0/docs/api/safe-storage.md) e [binding da mesma tag](https://raw.githubusercontent.com/electron/electron/v45.0.0/shell/browser/api/electron_api_safe_storage.cc): inspeção pontual de APIs/retorno e distinção dos caminhos sync/async; regras conservadoras por plataforma são recomendações desta proposta, não teste executado.
- [Node TLS](https://nodejs.org/api/tls.html): `checkServerIdentity` complementa verificações da cadeia; agente deve usar âncora privada, hostname esperado e pin adicional. Documentação latest consultada não substitui teste no Node embutido.
- [Node HTTPS](https://nodejs.org/api/https.html): servidor/agentes e configuração de timeout; política de deadlines e rastreamento de sockets é responsabilidade do adapter.
- [ws — projeto oficial](https://github.com/websockets/ws) e [API](https://github.com/websockets/ws/blob/master/doc/ws.md): Upgrade autenticado, configuração de limites e canal sobre servidor existente.
- [selfsigned — projeto oficial](https://github.com/jfromaniello/selfsigned): emissão X.509; API assíncrona e mudanças de versão. Algoritmos e validade precisam de opções explícitas.

**STATUS G1.1:** T1 aprovada pelo proprietário, inclusive a revisão pontual do serial. **G1.2-A/B/C/D:** Implementadas. **G1.3-A/B:** Parcialmente validadas; consulte a seção 18. **G1.3-C:** Revisão local e segunda revisão independente do Sol concluídas; aceitação final da G1 e validações ambientais restantes pendentes. **G2:** Não iniciada.

## Histórico do bloqueio inicial — serial X.509

Na revisão inicial do gerador fixado pela proposta (`selfsigned@5.5.0`), o [código-fonte dessa versão](https://github.com/jfromaniello/selfsigned/blob/v5.5.0/index.js) revelou que cria `serialBytes` com `crypto.getRandomValues(new Uint8Array(9))` e não expõe opção pública para informar o serial. Naquele momento, o requisito era de 128 bits e o achado bloqueou a execução.

O proprietário resolveu o bloqueio aprovando serial positivo/não zero com mínimo de 64 bits de entropia. O pacote gera 9 bytes criptograficamente aleatórios e converte o serial para valor positivo, preservando 71 bits aleatórios. O serial não é credencial de autenticação: identidade e confiança continuam protegidas por TLS validado, pin SHA-256 do DER e autorização G2. A implementação valida positividade/identidade do certificado, sem reescrever ASN.1 ou afrouxar outras garantias T1.

Histórico da execução bloqueada: dependências foram baixadas apenas para inspecionar a API, as alterações mecânicas em `package.json` e `package-lock.json` foram desfeitas e `npm audit` não pôde consultar o registry (`EAI_AGAIN`). Naquela tentativa nenhum módulo de produção foi alterado. Na execução retomada, dependências, testes e evidências são registrados no ticket G1; falha de consulta ao registry permanece limitação de auditoria, não resultado de segurança.

Registro histórico da verificação documental da revisão LAN: links/whitespace foram conferidos e `git diff --check` passou naquela rodada; nenhum teste funcional foi executado. Nesta tentativa de implementação, a verificação e o resultado do bloqueio estão registrados no topo e no ticket G1. Alterações preexistentes dos quatro arquivos `.codex/agents` permaneceram fora do escopo.

## 16. Revisão final solicitada — três decisões

| Ponto | Problema e alternativas | Complexidade / operador / risco | Recomendação |
|---|---|---|---|
| Renovação | Revisão anterior arquivo/QR substituída pela decisão LAN | PAKE acrescenta biblioteca/revisão criptográfica, mas remove transferência externa e conceitos técnicos do fluxo normal | Manter 365 dias; renovação pela UI/rede com PAKE e consentimento local; avisos 30/7 dias |
| Linux | APIs async existem, porém disponibilidade não atesta provider seguro; alternativa é novo secret manager ou limitar modo remoto | Exceção nativa sync no 45 é pequena/testável, mas deprecada e pode bloquear; sem cofre, local continua. Nada em claro | Windows async; Linux mesmo backend nativo verificável no 45 ou remoto desabilitado; revisão obrigatória antes de Electron 46 |
| Revogação | Bloqueio em RAM não sobrevive a crash; alternativa é estado durável em arquivo, banco dedicado ou autoridade externa | Um único arquivo de autorização com replace atômico evita banco novo. Escrita falha não permite declarar revogação permanente | G2 persiste geração/vínculo removido antes do sucesso; startup carrega antes da rede; sem fallback para estado autorizado antigo |

Histórico da revisão de renovação, armazenamento e revogação anterior à aprovação T1: naquela rodada não houve implementação, dependências persistentes, certificados, portas, Doop, F, commit ou push. A UX descrita continua pertencendo a G2/G5; G2 não foi iniciada. Testes adicionais estavam planejados e não foram executados. As decisões aprovadas e o bloqueio de implementação atual estão registrados nas seções vigentes acima.

## 17. Revisão de descoberta e pareamento LAN

[Complemento vigente](g1-1-t1-lan-pairing.md): alternativas, bootstrap SRP-6a/binding, descoberta real, portas/quotas, UX sem arquivo/QR/IP, renovação, reconexão e distribuição G1/G2/G4/G5/H4. Substitui somente as recomendações anteriores conflitantes, preservando o trabalho de cofre nativo/revogação durável. G1 implementa apenas infraestrutura e discovery; G2 continua responsável por PAKE/consentimento. A aprovação de 64 bits removeu o bloqueio de serial e autorizou retomar G1.2/G1.3. Nenhuma decisão de G2 é antecipada.

## 18. Implementação G1.2/G1.3 — evidências e limites

G1.2-A–D implementadas em `src/remote-contracts.ts`, `remote-secret-protector.ts`, `remote-tls.ts`, `remote-identity-store.ts`, `remote-clients.ts`, `remote-discovery.ts`, `remote-transport.ts` e `main-remote-runtime.ts`, com composição lazy do lifecycle em `main-runtime.ts`. O processo comum não inicia listener; não foram adicionados handlers de pairing, comandos de negócio, IPC/Preload de rede ou acesso à fila/playback. Dependências runtime fixadas: `multicast-dns@7.2.5`, `selfsigned@5.5.0` e `ws@8.22.2`; `@types/ws@8.18.2` é dev. `bonjour-service` foi removido do manifest e lock após as regressões confirmarem limitações incompatíveis com o cache exigido. O `node_modules` local ainda mantém uma cópia extraneous não empacotada; `npm ls --package-lock-only --depth=0` e o inventário ASAR confirmam o grafo distribuído sem ela. Licenças/transitivas foram inspecionadas; auditoria de dependências de produção anterior reportou zero vulnerabilidades.

| Lote | Evidência | Resultado |
|---|---|---|
| G1.2-A/B | `npm run compile`; suíte focada de infraestrutura; identidade atômica, safeStorage, serial/fingerprint DER, certificados inválidos/expirados e pinning | PASS |
| G1.2-C | Testes HTTPS/WSS loopback, deny-all, autenticação simulada por port, versão, payload, limites, revogação, fila serializada e races de lifecycle | PASS |
| G1.2-D | Unitários de parser/publicador mDNS, composition/lifecycle; E2E Electron real de modos operacionais | PASS local; não é validação LAN entre máquinas |
| G1.3-A | 7 testes determinísticos DNS-SD/cache; infraestrutura TLS/WSS 18/18; rede privada TLS 1/1; processos independentes 1/1; `npm run test:unit` PASS. Após corrigir bind UDP e filtrar origem/subrede, ensaio opt-in de anúncio/busca mDNS real passou no WSL. A regressão update/stop do publisher também passou | PARCIAL; multicast entre computadores/LAN nativa ainda não validado |
| G1.3-B | Electron 45/Linux real sob Xvfb verificou `basic_text` e manteve modo remoto desabilitado sem criar identidade. Smoke focado carregou o módulo discovery atual em Electron/ASAR; rebuild limpo bloqueado por `EAI_AGAIN github.com`. Runner nativo Windows NOT RUN; o CI existente tem job Windows para build, safeStorage e verificação do pacote | PARCIAL; validação nativa Windows e build limpa pendentes |
| G1.3-C | Diff revisado; `git diff --check`; teste unitário do runner Windows 38/38 após adicionar os testes de cache/lifecycle; segunda revisão do Sol confirmou as correções P1/P2 e repetiu infraestrutura/cache 25/25 + multicast real 1/1; sem Doop ou G2 | Revisão independente concluída; aceite final do proprietário e validações ambientais pendentes |

O teste Linux safeStorage mostrou `asyncAvailable=true`, backend `basic_text`, `remoteEnabled=false`, sem identidade persistida — PASS fail-closed, não PASS de armazenamento seguro habilitado. O ASAR Linux anterior foi empacotado em `/tmp/kq-g1-audit-package-final`; para o smoke atual, o `app.asar` foi extraído, o `build/src/remote-discovery.js` compilado atual foi sobreposto e o pacote temporário foi recriado; Electron 45 Run-As-Node carregou as classes do adapter e suas dependências incluídas. Nesta rodada, um rebuild completo para `/tmp/kq-g1-g13-final-package` falhou porque `electron-builder` não conseguiu acessar `github.com` (`EAI_AGAIN`); portanto, o smoke focado não equivale a uma nova build limpa. O E2E Standalone de produção não foi iniciado porque `KQ_PLAYER_TEST_MEDIA_DIR` não estava configurado e não há fixture aprovada no repositório; quando houver fixture isolada autorizada contendo `01001.mp4`, executar `npm run test:e2e:standalone-production:headless` com essa variável. O workflow existente `.github/workflows/pr-validation.yml` tem Windows `windows-latest` para build x64, safeStorage e verificação de pacote, mas não foi disparado. O runner nativo é NOT RUN pela falha WSL/Windows registrada (`UtilBindVsockAnyPort:307: socket failed 1`); `scripts/windows-native-runner.test.cjs` passou 38/38 após o modo focado `--remote-infrastructure` incluir as regressões determinísticas de cache e concorrência do publisher. Não houve teste entre computadores físicos. G1.3 permanece incompleta até obter evidência necessária e revisão.
