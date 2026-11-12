# T1 — Descoberta e pareamento integral pela LAN

## Estado e precedência

**Complemento LAN aprovado como parte da T1 em 2026-11-11.** O contrato de descoberta/bootstrap descrito aqui foi implementado na infraestrutura G1.2, sem handlers de pairing ou confiança operacional. G1.3 ainda aguarda validação Windows; multicast real local passou após corrigir o bind UDP, e o módulo discovery atualizado passou em smoke focalizado dentro de ASAR. A descoberta entre computadores em LAN física segue para validação posterior; rebuild ASAR limpo continua pendente por indisponibilidade de rede. Ver [evidências da T1](g1-1-t1-secure-transport-proposal.md#18-implementação-g12g13--evidências-e-limites). G2 permanece não iniciada. Este complemento integra a [T1](g1-1-t1-secure-transport-proposal.md) e substitui recomendações anteriores de descoberta apenas manual, vínculo por arquivo/QR/fingerprint e ausência de PAKE. Descoberta → seleção → confirmação segura pela UI/rede local continua sem internet. Identidade, TLS pinado, bearer revogável, armazenamento nativo, arquivo durável de autorização e contratos D1–D5/T2 permanecem preservados.

As recomendações G2 abaixo descrevem PAKE, consentimento e vínculo ainda não implementados. A infraestrutura DNS-SD/TLS Main-only de G1.2 existe; G1.3 permanece parcial e G2 não começou. [Contrato funcional](paired-mode-contract.md), [sequência](paired-mode-execution-plan.md), [interfaces planejadas](paired-mode-ui-plan.md). Fontes primárias ao final. A análise inicial não abriu portas, gerou certificados, instalou dependências, executou testes de aplicação ou alterou Doop; os resultados da implementação estão na seção de evidências da T1.

## 1. Escolha e alternativas

| Questão | Escolha aprovada | Alternativas e motivo |
|---|---|---|
| Descoberta | mDNS/DNS-SD IPv4, Player anuncia e Gestão procura; endpoint manual avançado como recuperação | Scan de sub-rede/broadcast proprietário: mais tráfego e protocolo próprio; serviço externo/cloud: incompatível com operação sem internet; mdns nativo: SDK/daemon/instalação desnecessários |
| Primeiro vínculo | SRP-6a com código aleatório de uso único mostrado no Player e digitado na Gestão; provas mútuas e binding autenticado do certificado | Código bearer enviado em TLS não confiado permite roubo/MITM. TOFU silencioso e mero clique no nome não autenticam. Comparação de SAS exige protocolo de compromisso/validação correto, não hash curto inventado |
| PAKE | Biblioteca existente `fast-srp-hap`, perfil fixo `params.hap` (SRP 3072/SHA-512), sem implementar matemática | SPAKE2/OPAQUE são alternativas padronizadas relevantes, mas não há dependência/adaptação já validada neste projeto; não escolher uma implementação artesanal para reduzir dependências |
| Persistência posterior | TLS com pin completo e bearer individual G2; reconexão sem redigitar código | PAKE a cada conexão piora uso; mTLS continua mais complexo sem ganho proporcional neste modelo |
| Certificado anual | Novo pairing pela mesma UI e PAKE, após geração local de certificado válido novo | Renovação automática/CA/migração de pins continuam fora da primeira versão |

Decisão implementada em G1.3: não usar o browse de `bonjour-service@1.4.4`, porque o cache interno não oferece limites, TTL confiável ou atualização apenas de A records. `multicast-dns@7.2.5` implementa anúncio e consulta DNS-SD no adapter Main com cache limitado a 512 registros e 64 candidatos, escopo por interface e atualização/checagem de rede a cada 60 segundos. Respostas duplicadas renovam TTL; cache-flush troca endpoint; goodbye e TTL vencido removem anúncio. Registros fora da cadeia `_kq-player._tcp.local` não consomem cache. Os sockets UDP fazem bind wildcard somente para multicast, associam membership à interface selecionada e filtram a origem IPv4 pela mesma subrede. O formato DNS-SD, serviço/porta/interface e regra de descoberta não confiável permanecem os mesmos; nenhuma confiança é concedida por mDNS. `ws` e `selfsigned` permanecem; `fast-srp-hap` continua exclusivo de G2. A causa, correções e regressões estão em [auditoria independente](g1-independent-audit.md).

**Gate criptográfico obrigatório:** SRP é protocolo existente, mas seu encapsulamento e o binding TLS são parte do contrato da aplicação, não um padrão completo magicamente fornecido pela biblioteca. G2.1 deve fixar versão/perfil, formato de transcript/provas e verificar vetores/interoperabilidade e revisão independente de segurança **antes** de autorizar o fluxo em produção. Não alegar biblioteca auditada: esta análise não encontrou/provou auditoria independente. Se a biblioteca não oferecer garantias necessárias ou a composição não for validada, bloquear G2; não escrever outro PAKE nem remover binding como fallback. Isso é gate técnico específico de validação, não liberdade para redefinir arquitetura silenciosamente.

## 2. Descoberta leve, não confiável

### Quem anuncia e procura

- Player anuncia `_karaokequeue._tcp.local` somente depois de permissão local para ser encontrado, identidade/cofre válidos e listener restrito pronto. A permissão pode ser persistida por conta; primeiro setup pede em linguagem simples “Permitir encontrar este Player nesta rede?”. O Player independente não abre rede por mera importação de módulo ou por receber tráfego.
- Gestão inicia busca curta ao abrir (se uso de rede local consentido), reabre ao clicar no ícone de dispositivos e permite Atualizar. Não abre servidor TCP operacional.
- Primeira configuração usa automaticamente a única interface elegível RFC1918 não interna; se houver várias redes, pedir escolha pelo nome do adaptador/rede, sem exigir IP. IPv4 privado não comprova interface física nem rede confiável; VPN pode parecer elegível. Não anunciar em todas as interfaces por default. Preferência de interface local persistida, revalidada quando rede mudar.
- Em listener TCP, manter bind explícito no endereço selecionado; UDP mDNS usa 5353/224.0.0.251 e associação à interface escolhida. O socket multicast pode exigir bind wildcard com reuseAddr por semântica do SO: essa exceção UDP deve filtrar interface/origem e não relaxa o bind do servidor HTTPS. Testar sem depender de serviço Bonjour instalado ou daemon Avahi.

### Conteúdo e estados

PTR/SRV/TXT/A suficientes para obter porta/endereço candidato. TXT mínimo: versão de descoberta, deviceId público, nome amigável limitado e indicação de disponibilidade de pairing. Não publicar segredo, código PAKE, salt/verifier, token, pin como prova, usuário/sessão/cantor, catálogo ou paths. Nome do dispositivo/ID visíveis na LAN têm impacto de privacidade; não usar nome da conta/hostname pessoal por default. Conflito de nomes usa resolução da biblioteca e sufixo visível, não sobrescrita de identidade.

Anúncio não prova nem nome, deviceId, IP, estado ou versão. Entrada “Encontrado / não verificado” vem da descoberta real; “Vinculado salvo” vem do estado local persistido; “Conectado” só após TLS/auth/handshake; “Indisponível” após expiração/perda real. Nunca pintar peer como confiável por TXT. Entrada conhecida em cache pode aparecer separada como “Vinculado, não encontrado agora”, sem fingir anúncio atual.

Cache limitado a 64 candidatos, nome <=64 caracteres/TXT total <=512 bytes, endereços privados locais plausíveis, porta válida, sem URLs/redirect/DNS externo. Chave de candidato inclui interface+instância+endpoint; deviceId alegado não permite substituir silenciosamente trust/endpoint ativo. Falso anúncio do ID conhecido pode receber tentativa TLS estrita, mas não troca pin nem apaga vínculo. Limitar resolução/conexões a 2 simultâneas e 4 candidatos/endereço por peer conhecido por ciclo. Renderizar nomes como texto, sem HTML.

Busca ativa inicial por até 15 s, refresh manual coalescido com intervalo mínimo de 5 s, depois consultas espaçadas a no mínimo 60 s enquanto necessário; usar TTL/known-answer suppression da biblioteca, cache com expiração e limpeza. Valores iniciais propostos, não tuning comprovado. G4 solicita novo ciclo quando dispositivo vinculado desaparece, sem buscar rede inteira. Não fazer handshake TLS/SRP para cada anúncio: só seleção explícita ou reconexão de identidade já vinculada.

No encerramento anunciar goodbye quando possível, retirar serviço e fechar UDP/timers/listeners. Crash/suspensão podem impedir goodbye: TTL é obrigatório. No resume/rede alterada, revalidar interface, retirar endereço velho, reanunciar de maneira limitada e notificar G4. Anunciar não muda modo offline nem autoriza tomada de controle.

### Limitações inevitáveis

Multicast pode ser bloqueado por firewall, roteador ou redes guest; client isolation pode impedir também TCP. A UI oferece Atualizar, conferir mesma rede e conexão por endereço em área Avançado; digitar endereço não pula PAKE. Sem multicast mas com TCP possível, fallback manual funciona; sem comunicação entre máquinas, o app não consegue resolver isolamento sozinho. Não mudar firewall, abrir UPnP, instalar serviço ou exigir admin silenciosamente. Não prometer descoberta entre VLANs/VPN/roteadores; primeira versão IPv4 local. Dois peers no mesmo computador não comprovam Windows LAN real G6.

## 3. Bootstrap separado do canal operacional

### 3.1 Candidato e TLS provisório

1. Seleção na lista produz `DiscoveryCandidate` não autorizado, nunca `TrustedPeer`.
2. G1 fornece factory isolada de **canal de bootstrap** com teto/deadline e allowlist `/v1/pair/*`. Não expõe `rejectUnauthorized:false` a UI/ports genéricos.
3. Para primeiro contato, um probe TLS limitado obtém só o certificado candidato e fecha. Ele não autentica o peer e não envia HTTP, código, token ou dados de negócio. É a única exceção estritamente isolada de validação normal; não é conexão operacional.
4. Criar agente privado de bootstrap com esse candidato como âncora provisória, checagem de validade/estrutura/SAN e pin **do candidato**, `rejectUnauthorized:true`, sem redirects/sessões TLS reaproveitadas. Isto impede trocar o certificado no meio da sessão, mas ainda não comprova que o dispositivo é o desejado. O PAKE e o consentimento é que estabelecem confiança.
5. O canal só leva solicitação não sensível, valores públicos/provas PAKE e confirmação autenticada do contexto; nenhum bearer operacional antes de confiança persistida. Canal de controle `/v1/control`, catálogo, status e comandos permanecem negados.

Não é correto chamar “TLS autenticado” ao probe ou pin provisório. A concessão não pode ser generalizada aos adapters HTTPS/WSS normais, que continuam exigindo trust persistido. O mecanismo é G1; handler e estados de pairing são G2. Sem G2 injetada, nenhuma rota bootstrap útil existe; G1 não implementa pareamento.

### 3.2 Consentimento e código de sessão

Gestão solicita vínculo ao candidato escolhido. Player mostra pedido com nome da Gestão explicitamente “nome informado, ainda não verificado”, opção Rejeitar/Permitir e estado de solicitação. Não mostrar código por anúncio mDNS ou antes da permissão local. Após Permitir, Player gera **8 dígitos uniformemente aleatórios**, exibe agrupados 4–4, e cria salt/estado SRP efêmeros; operador digita o código na Gestão e confirma.

Código de uso único, mantido em memória e mostrado só no Player até ser digitado na Gestão selecionada, não transmitido em claro nem como simples hash/verificador de senha; não vai a log, TXT, clipboard automático ou trust store. G2 usa a implementação SRP para provas M1/M2 e chave de sessão; nunca usar número como token bearer ou pin TLS. Validar valores públicos/grupo conforme biblioteca; recusar zero/mod N/valor malformado e parâmetros negociados arbitrários. Não aceitar downgrade para outro perfil/algoritmo. Identificador SRP é uma identidade de pairing de domínio fixo/sessão, não nome humano editável.

Uma sessão de pairing por Player, inclusive duas Gestões simultâneas: reserva serializada no Main; outra recebe ocupado, sem trocar pedido/código de quem já foi aceito. Janela de 120 s, cada sessão até 3 provas incorretas; após falha cancelar e exigir novo consentimento/código. Limite global de 5 falhas em 10 min para pairing; antes de cada tentativa cara e entre requests verificar quota. Penalidade independe de IP/controllerId alegados; limitar mapa/IP conforme G1. Restart aborta sessões e pede novo consentimento; não tentar ressuscitar código antigo. O contador temporário em memória não autoriza tentativa após restart sem ação local.

Rejeitar, cancelar, expirar, perder conexão ou falhar prova apaga estado/chave/código efêmeros, libera slot só pela geração correspondente e não cria vínculo. Para reduzir DoS de prompts, só um pedido visível, no máximo 3 pedidos/min global e opção local “não aceitar pedidos”; novo cadastro/re-pair não pode tomar o vínculo existente por tráfego remoto. Falha de quota não interrompe playback. Controles de pairing não pausam música; troca/revogação do vínculo ocorre em manutenção segura sem interromper vez aceita por efeito colateral.

### 3.3 Bind do PAKE ao certificado — obrigatório

Verificar M1/M2 não basta se o resultado for usado para fixar qualquer certificado apresentado por um intermediário. Após provas mútuas, ambos confirmam contexto autenticado pelo segredo SRP, com separação de papéis/direção. O contexto deve incluir versão de bootstrap/perfil, sessionId de pairing não reutilizável, nonces frescos de ambos, deviceId/controllerId, fingerprint DER **do certificado TLS efetivamente usado**, revisão/geração do vínculo esperado e finalidade inicial/renovação. Nomes humanos não definem identidade.

Contrato mínimo: Player autentica seu próprio fingerprint; Gestão compara com o fingerprint observado no canal provisório e responde autenticando a mesma identidade/contexto. Replay ou fingerprint diferente encerra sem trust/token. Um MITM que só retransmite SRP entre duas conexões TLS de certificados diferentes não pode substituir essa confirmação sem conhecer o segredo. Relay transparente até o mesmo endpoint não cria outro peer/controlador.

Usar apenas primitivas estabelecidas de biblioteca/`node:crypto` (HKDF e MAC com rótulos de direção/contexto), nunca fórmula PAKE, comparação de SAS ou AEAD própria. **O encoding canônico, derivação e confirmação são revisão obrigatória G2.1**, com vetores e simulação ativa de MITM; não tratar a descrição acima como wire format auditado ou inventar essa composição diretamente em produção. Recomendação é SRP-6a com binding confirmado; se não for possível validar a composição, T1/G2 não estão liberadas para implementação desse fluxo. A aprovação arquitetural não equivale à aprovação do wire contract criptográfico. Não remover a verificação para obter PASS.

Só depois das provas, consentimento bilateral e binding: Gestão prepara e persiste candidato de trust/segredo em estado pendente, sem publicar vínculo ativo. Em conexão TLS estrita ao certificado agora comprovado pelo PAKE, concluir commit G2 por sessão autenticada pelo segredo efêmero e contexto: Player persiste vínculo/revisão/hash da credencial, confirma, e Gestão finaliza seu estado confirmado. A credencial individual só é transportada nessa conexão estrita após o binding, nunca antes das provas. O formato/autenticação do commit também deve ser validado em G2.1. Token novo em trânsito apenas após confiança, não no anúncio/probe. Repetição/falha parcial deve reconciliar a sessão de pairing com mesmo ID, nunca emitir múltiplos vínculos ativos. Se Player commitou mas Gestão perdeu resposta, pedir resolução por sessão sob canal autenticado/PAKE ainda válido ou novo procedimento explícito; não abrir controle sem ambos os estados confirmados. G3/G4 cuidam operações de negócio; a pequena máquina de estado de pairing pertence a G2.

## 4. Fluxo percebido pelo operador

1. Abrir Gestão; busca real inicia na rede autorizada.
2. Clicar no ícone **Dispositivos**, imediatamente à esquerda do sino de notificações da barra superior, preservando o sino.
3. Selecionar “Player do salão”. A lista mostra encontrado/não verificado, não “conectado”.
4. No Player correto, aceitar o pedido local. A tela mostra oito dígitos.
5. Digitar esses dígitos na Gestão e confirmar. As aplicações fazem as provas e salvam o vínculo; sucesso somente após persistência confirmada.
6. Mostrar conectado/reconciliando, depois pronto quando G3/G4/H permitirem. Nenhum modal adicional para iniciar uma vez já promovida.

Cerca de 5 ações de interface, contando preencher+confirmar código como uma etapa de interação; digitação de oito dígitos é adicional aos cliques. Primeira habilitação de rede Player pode acrescentar uma confirmação. Sem arquivo, QR, IP, fingerprint ou internet no caminho normal. Não prometer operação com rede isolando clientes. Nomes duplicados/desconhecidos são esclarecidos pelo pedido e código **na tela física do Player desejado**, não por identificação técnica. Se o Player real não mostrar pedido, operador cancela.

## 5. Reconexão G4 e autoridade

Vínculo válido persiste em ambos os perfis. Ao iniciar Gestão ou ver anúncio novo de peer salvo, G4 tenta conexão TLS pinada e bearer sem novo código. Endereços mDNS/cache são pistas: validar pin/ID antes de enviar credencial; endereço errado/falso nunca atualiza confiança. Tentar último endpoint privado confirmado é permitido, mas indicar cache separado de descoberta real.

Uma tentativa ativa por vínculo; backoff exponencial com jitter limitado (1, 2, 4, 8, 16, máximo 30 s), cancelável no shutdown/desabilitação. Evento de rede/Atualizar pode antecipar uma tentativa dentro da quota, sem loops ou duplicação. Testes usam relógio/RNG controlados. Remover listeners antigos e controlar geração; busy não expulsa conexão válida nem cria segunda Gestão. Mudança de IP válida atualiza endpoint confirmado, sem re-pair se certificado/identidade não mudaram.

Após socket: snapshot/resultados/operationId/cursor e reconciliação existentes; controles dependentes só depois. Uma queda não interrompe apresentação/música/segunda música da vez aceita. Se Player foi explicitamente colocado offline, pode voltar a ter transporte autenticado para mostrar estado/conciliar, mas **não reassume controle**; exige transição explícita e H3 takeover quando necessário. Reconexão automática de transporte não altera D2/D3 ou seleção de função instalada.

## 6. Renovação, perda e revogação

Manter 365 dias, avisos discretos 30/7 dias e ação **Renovar vínculo**. Sem renovar certificado/pin silenciosamente. Operador inicia na UI do Player e seleciona o mesmo dispositivo na Gestão; repetir confirmação/código SRP e persistir novo trust/credencial, revogando o anterior. Sem arquivo/QR.

Antes do vencimento, manutenção pode começar no canal ainda válido, mas novo pin exige o novo pairing aprovado. Após vencimento, adapter operacional recusa TLS antigo. Player mostra localmente “Renovar vínculo” e gera/persiste certificado válido novo em manutenção segura; reanuncia candidato de recuperação. Nova confiança usa canal bootstrap separado + PAKE e confirmação local, **não** bearer antigo enviado a certificado desconhecido/expirado. O botão Gestão pode orientar/selecionar candidato, mas não ordenar geração/revogação através de conexão não autenticada; sem acesso ao Player não há recuperação silenciosa.

A geração/vínculo ativo persistido no Player continua single-writer e fail-closed conforme §5.6 da T1 principal. Re-pair exige retirada explícita do vínculo anterior, consentida localmente e duravelmente confirmada; nomes/IDs descobertos nunca revogam um Controller existente. Trocar computador ou perder segredo usa mesmo fluxo local de desvincular/revincular, sem importar perfil/fila nem apagar journal. Se disco falhar, não declarar vínculo renovado/removido; manter remoto bloqueado conforme contrato. Sem armazenamento seguro Linux, UI explica remoto indisponível e preserva local.

## 7. Ports, módulos e lotes sem ciclos

| Fase | Contratos/responsabilidades e novos módulos propostos |
|---|---|
| G1 | `DiscoveryCandidate` (não autorizado), `DiscoveryPort` start/refresh/subscribe/stop, `BootstrapChannelFactory` isolada, limites/schema de envelope e `RemoteAuthorizationPort` deny-all. Acrescentar `src/remote-discovery.ts` aos cinco módulos T1; biblioteca encapsulada, sem engine/regras |
| G2 | `PairingCoordinator` Main, sessão/consentimento/código, provider SRP de biblioteca, binding, trust/credencial/renovação e arquivo de autorização. `src/remote-pairing.ts` e `src/remote-pairing-store.ts` propostos, não existentes. G2 consome ports G1; G1 não importa PAKE/G2 |
| G4 | Scheduler/backoff, nova resolução de candidatos de identidade salva, reconexão e reconciliação; consome discovery/transport e trust G2/G3. Não anuncia/consente por conta própria |
| G5 | UI do ícone/lista/pedido/código/renovação e estados reais de conexão via IPC específico; nenhum segredo persistente no Renderer. Código efêmero só no DTO estritamente necessário à tela/entrada, nunca logs |
| H4 | Integra estado pareado/offline/takeover e habilitação dos controles operacionais. Não implementa outro pareamento, mDNS ou protocolo PAKE |

`DiscoveryCandidate` contém ID efêmero da observação, nome não verificado, interface/endpoint privados e prazo de frescor. `TrustedPeer` só vem do store/consentimento G2. `PairingRequest` usa operation/session ID próprio com finalidade e alvo; `PairingStatus` diferencia solicitado, esperando permissão, esperando código, verificando, persistindo, vinculado, rejeitado, cancelado, expirado e erro/resultado incerto. SessionId de pairing não se confunde com sessão de karaokê.

Dependências propostas: G1.2-A contratos/discovery → G1.2-B TLS/ports bootstrap → G1.2-C limites/lifecycle → G1.3 negativos e integração. G1 testa com autorização deny-all e provider fake; sem PAKE de produção. G2.1 valida perfil/binding e contrato visual antes do fluxo G2.2; G2.3 testa persistência/falhas/revogação. G3 permanece protocolo operacional; G4 integra reconexão; G5 monta UI final aprovada após G1–G4; H4 só operação.

Para não criar ciclo “G2 precisa UI G5 mas G5 precisa G4”, G2 possui testes de consentimento via port de apresentação e fixtures, sem expor fluxo incompleto em produção. G5 integra a apresentação real no aplicativo posteriormente. Nenhum harness de consentimento equivale a UI pronta, e G2 só habilita pairing de produção quando apresentação local restrita real estiver disponível e aprovada. Gates técnicos e homologação mantêm-se; não iniciar etapas automaticamente.

## 8. Matriz de testes obrigatória, ainda não executada

| Grupo | Oráculos / fase |
|---|---|
| DISC | Anúncio/browse reais, TTL/goodbye, UDP bloqueado, DHCP/resume, VPN/múltiplas interfaces, cache/limites/nomes falsos, falso deviceId e endpoint público; nunca autorizar pelo TXT. G1 unitário/loopback e G6 LAN Windows/Linux |
| PAKE | Vetores da biblioteca/perfil; código errado, zero/mod N, salt/parâmetro inválido, downgrade, replay/reflection, provas M1/M2 ausentes, MITM com certificados distintos e relay de SRP; nenhum pin/token antes de binding. G2.1/2.3 |
| CONSENT | Player errado com mesmo nome, duas Gestões, pedido rejeitado, cancelamento, timeout, quota global/tentativas, rede cai ou restart durante cada passo; nenhuma sessão automática após restart. G2 |
| DURABLE | Crash/falha antes/depois de gravar trust/token/activeBinding, resposta perdida, retry da mesma sessão e revogação+restart. Sem falso sucesso, dupla Gestão ou retorno do token antigo confirmado revogado. G2 |
| RECONNECT | IP novo mesmo pin, anúncio falso com pin diferente, backoff coalescido, autenticação falha, busy/duas conexões, shutdown/resume, offline explícito preservado; operações incertas permanecem por ID. G4 |
| RENEW | Certificado expirado bloqueado, geração nova local, recuperação PAKE sem usar token antigo antes de confiar, vínculo anterior revogado, falha de disco e avisos 30/7 dias sem interromper playback. G2/G4/G5 |
| UI | Ícone ao lado do sino, busca vazia/bloqueada/real, estados não verificado/vinculado/conectado/indisponível, teclado/foco/código sem log, erro/rejeição/timeout/renovação. Capturas Electron×Doop só na futura implementação autorizada G5/H4 |
| RESOURCE | Flood mDNS/requests PAKE, limites de caches/crypto e event loop durante playback, ausência de timers/socket residual. G1/G2/G6, performance extensa em H6 |

Sem sleeps arbitrários: relógio/RNG/barreiras controlados e rede sintética para faults. E2E Electron/IPC com cofre e perfis isolados; Windows oficial em NTFS. Testes de duas máquinas G6 são necessários para multicast/firewall real; H5 continua validação operacional, não concluída por G6. Reutilizar CI, sem workflow novo nem instalação física nesta rodada.

## 9. Narrativa de uso

O estabelecimento instala Gestão em um computador e Player no computador ligado à TV. No Player o operador permite encontrá-lo naquela rede. Abre Gestão, clica no ícone ao lado do sino e vê “Player do salão”, encontrado na LAN. Seleciona-o. Na TV aparece o pedido, ele aceita e lê os oito dígitos. Digita-os na Gestão e confirma. Os aplicativos verificam o código via PAKE, a identidade TLS e salvam o vínculo. Após conciliar, a Gestão pode enviar a vez atual.

Durante uma música o Wi-Fi cai. Player continua a vez já aceita e guarda resultados. Gestão mostra reconectando. Quando a rede volta, localiza o mesmo Player, autentica pelo vínculo salvo e concilia; não pede código novamente. Se, durante a queda, o operador escolheu explicitamente modo offline depois de encerrar a vez, a reconexão não retoma controle: Gestão oferece o retorno/takeover já previsto. Um ano depois, o aviso de renovar guia a repetição do vínculo pelas duas telas, sem arquivos, QR ou configuração técnica no fluxo comum.

## 10. Aprovação e limites

Direção funcional de UX está determinada pelo proprietário. A solução técnica proposta ainda requer aprovação T1: mDNS via biblioteca, SRP-6a e binding autenticado, código de oito dígitos, quotas/expiração, nova superfície bootstrap restrita, política de interface consentida e gates de revisão criptográfica. Não há alegação de composição SRP/binding já auditada ou de compatibilidade nativa já testada. Caso o proprietário queira aprovar T1 para implementar G1, o gate G2.1 continua impedindo implementação de pairing de produção sem validação criptográfica.

Continua impossível garantir descoberta em rede guest isolada ou cofre Linux inexistente; recuperação explica a limitação, não enfraquece autenticação. Código exposto na tela pode ser visto por quem está fisicamente no estabelecimento; PAKE não protege contra observação local do código e consentimento concedido ao pedido errado. Mostrar o código somente na janela local temporária, não no anúncio/status remoto, e exigir que operador confira o pedido no Player desejado. Avaliar exposição na TV ao planejar G2/G5; não alegar autenticação contra adversário que já vê o segredo e obtém consentimento. Criptografia em JS/SRP pode consumir Main: limitar concorrência a uma sessão, medir nos testes, não prometer desempenho antes da evidência. Caso haja bloqueio significativo, revisar implementação antes de disponibilizar; não antecipar otimização/worker sem medição. T2 e parte restante D2 não mudam. Todos os frames novos desta experiência ainda estão **a planejar/criar após autorização visual**, não criados nesta rodada.

## 11. Fontes primárias

- [RFC 6762 — mDNS](https://www.rfc-editor.org/rfc/rfc6762), [RFC 6763 — DNS-SD](https://www.rfc-editor.org/rfc/rfc6763): descoberta local, não autenticação do dispositivo.
- [bonjour-service](https://github.com/onlxltd/bonjour-service) foi auditado e descartado na implementação por não expor limites de cache/TTL/endereço; [multicast-dns](https://github.com/mafintosh/multicast-dns) é usado diretamente no adapter com cache local limitado.
- [fast-srp-hap](https://github.com/homebridge/fast-srp), [uso no HAP-NodeJS](https://github.com/homebridge/HAP-NodeJS/blob/latest/src/lib/HAPServer.ts): implementação SRP existente; não é evidência de auditoria ou compatibilidade deste adapter.
- [RFC 5054](https://www.rfc-editor.org/rfc/rfc5054), [RFC 9382 — SPAKE2](https://www.rfc-editor.org/rfc/rfc9382.txt): mecanismos estudados. Não afirmar que SRP em HTTPS equivale à integração TLS-SRP do RFC 5054 ou que o binding específico aqui já seja padronizado.

**T1: aprovada. G1.2-A–D: implementadas. G1.3: validação parcial; multicast real local e smoke focalizado do módulo em ASAR PASS; Windows nativo e rebuild ASAR limpo pendentes; LAN física entre computadores não validada. G2: não iniciada.**
