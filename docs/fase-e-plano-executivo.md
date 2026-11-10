# Fase E — Plano executivo técnico E0–E5

**Adição autorizada em 2026-11-09:** ativação no topo ocioso do Reprodutor, licença persistida comum às duas funções e startup Player em fullscreen. [Implementação, regressões e limites](fase-e-player-licenca-fullscreen.md). Testes locais e runner Windows PASS nos snapshots indicados; o novo commit exige CI/artifact próprios. Não muda S1 PARTIAL nem a homologação pendente E1–E5.

**CI de validação — 2026-11-09:** ambos os jobs PASS e primeiro artifact NSIS baixado/verificado no SHA b92e950. [Evidência, fingerprint, hash e limites](fase-e-revisao-independente.md#24-primeiro-ci-integral-pass-e-artifact--2026-11-09). GO somente para validação do candidato; S1 PARTIAL e E1–E5 sem homologação.

**Registro após correções estruturais de 2026-11-09: GO técnico condicionado para revisão final/PR exclusivamente de validação automatizada.** O [parecer, seção 10](fase-e-revisao-independente.md#10-correção-estrutural-da-coordenação-f1f3--2026-11-09) registra F1–F3 corrigidos, testes Windows/NSIS de fixtures e novo candidato x64 build/verify PASS. Substitui o NO-GO histórico da seção 9, sem substituir uma nova revisão independente nem liberar homologação/distribuição. Não houve commit/push/PR/dispatch nesta correção. Ver [contrato de coordenação e matriz](fase-e-coordenacao-instalacao.md).

Data da auditoria: 2026-11-07. Base: branch `feature/remote-player-lan-integration`, HEAD `10548d54e80825c6e6ddbdaf8f7038207bdabee3`, árvore limpa antes desta documentação. Revalidar código e Git antes de executar qualquer lote.

**Estado atualizado em 2026-11-09:** E0 CONCLUÍDA E APROVADA; decisões A1–A7 aprovadas; S1 permanece PARTIAL. O proprietário autorizou desenvolvimento sequencial de E1-03 até E5-03, incluindo correções/validações de E1-02. Essa autorização substitui os limites anteriores de autorização de desenvolvimento, mas **não** aprova tecnicamente etapas, dispensa homologação nem libera distribuição. O [ledger, seção 16](#16-coordenação-estrutural-f1f3--2026-11-09) registra o snapshot Windows atual e suas lacunas; relatos anteriores abaixo são históricos. Smokes protegido/NSIS silencioso passaram no primeiro CI integral (seção 24 do parecer); UAC interativo, cross-account e sessões Windows permanecem NOT RUN; nenhuma etapa E1–E5 ou a Fase E está aprovada.

## 1. Autoridade, uso e limites

O [roadmap](standalone-player-roadmap.md) governa ordem, escopo e aprovações. Os [tickets E0–E5](backlog/0005-fase-e-instalador-gerenciamento-funcoes/) recebem a evidência de execução; os lotes deste plano são subdivisões desses tickets, sem criar novos IDs de ticket. A organização plana de documentos técnicos existente é preservada.

Consultar também [arquitetura remota](remote-player-architecture.md), [preparação D4](d4-main-remote-architecture-preparation.md), [segurança SQLite](sqlite-persistence-safety.md), [compatibilidade legada](legacy-session-compatibility.md), [playback](player-playback.md), [biblioteca](video-library.md), [catálogo](music-catalog.md), [UI](standalone-player-ui-plan.md), [testes Windows](windows-native-testing.md) e [release Windows](windows-release-process.md). A V1 Standalone não será editada.

Fora de E: transporte/pairing/segurança remota G, reconciliação de filas G/H, reprodução local integrada à Gestão H8, novas regras de fila, unificação de bancos e campanha de estabilidade/performance F/H6. A infraestrutura local de mídia já existente no Combined será preservada; isso não transforma E em H8.

Cada lote exige autorização explícita aplicável. O proprietário pode autorizar um conjunto nominal de lotes da mesma etapa, permitindo execução sequencial autônoma; nunca inferir autorização do próximo lote/etapa. E0 concluída **e aprovada** antecede E1. A1–A7 já estão aprovadas; E1-01 exige aceite explícito do detalhamento limitado antes de autorizar desenvolvimento isolado E1-02; comprovação crítica real e aceite integral ficam antes da homologação/aprovação E1, conforme seção 9 do contrato. Não reapresentar A1–A7 como decisões pendentes. E2, E3, E4 e E5 têm gates próprios. Uma pendência visual bloqueia somente o trabalho dependente dela, sem autorizar inventar referência.

## 2. Auditoria do código real

### 2.1 Controller versus Combined

| Aspecto | Controller atual | Combined atual | Consequência para E0 |
|---|---|---|---|
| Resolução | `src/operating-mode.ts`: aceita `controller`; ausência de configuração retorna Controller | Aceita `combined` | Separar valor legado lido da função efetiva; não regravar perfil automaticamente |
| Capacidades | `{ controller: true, player: false }` | `{ controller: true, player: true }` | A capability `controller` representa Gestão, não uma terceira função futura |
| Gestão | `main.ts` cria `KaraokeApplication`, repository e `MainManagementHost` | Mesmo ramo e mesma composição | Reutilizar autoridade Main-side; não criar outro app/writer |
| Banco operacional | `createKaraokeDatabase(userData)` | Mesma factory e arquivo `karaoke.sqlite` | Não há necessidade demonstrada de conversão/fusão para consolidar a função |
| Catálogo | Serviço no banco operacional | Serviço no banco operacional, associado à biblioteca | Preservar sem copiar para o catálogo Player |
| Mídia | Não inicializa infraestrutura Player | `MainMediaRuntime` inicializa biblioteca, protocolo, recovery, playback e `ManualPlaybackService` | Alias Controller → Combined pode ativar caminhos antes ausentes; testar configuração de mídia inválida/indisponível e falhas de startup |
| Janela/preload | Gestão em `src/index.html`, `preload.ts`, factory de Gestão | Mesma janela/preload; handlers Player adicionais | Inspecionar consumidores e permissões, não só trocar strings |
| Sequência Standalone | Ausente | Ausente; `createStandaloneSequence()` exige `player` | Não anexar sequência Standalone à fila da Gestão |
| Troca atual | `changeControllerOperatingMode()` permite Controller → Player com flush/relaunch | Não registra essa troca; Combined é rejeitado em caminhos transitórios | Retirar opção final Controller e fechar canais de troca conforme recorte abaixo |
| Encerramento | Coordenadores Gestão e flush do host | Gestão mais recursos de mídia/catálogo | Testar drain, falha de persistência e cleanup de ambos |

`src/main-management-host.ts` publica snapshots confirmados e coordena deduplicação; `src/application.ts`/`src/state-repository.ts` continuam donos da serialização/persistência operacional. Não mover regras para Renderer ou para o controle de instalação.

`src/welcome.html` oferece três cartões, permite seleção Combined e informa troca futura nas Configurações. `welcome:choose-mode` em `main.ts` valida com o tipo de três modos, salva no perfil e relança; não executa o segundo passo aprovado de biblioteca/CSV. `src/ui/settings-view.ts` pressupõe Controller e desabilita Combined. `src/main-player-ipc.ts` conserva caminho transitório de troca para Controller. A retirada visual do seletor Standalone em C10 não prova remoção desses contratos de backend/Gestão. Este é o estado auditado antes da E0-01/02.

E0 deve deixar somente duas funções finais, compatibilidade de leitura Controller e dados intactos. Recomendação: resolver Controller legado como Combined em memória, sem modificar o JSON ou banco na leitura; produção passa a gravar apenas `player`/`combined`. Preservar parser legado estrito, limites e rejeição de arquivo/link inválido. Não fazer substituição global de `controller`: nomes de capabilities, handlers, testes e histórico podem continuar necessários.

Recorte E0/E1: conforme A7, E0 retira Controller como opção e remove a troca normal em Configurações/IPC; E1 implementa onboarding de dois passos e a troca posterior exclusivamente pela manutenção NSIS. Nenhuma tela nova de instalador em E0. O Welcome usa o frame aprovado `rKUlA0rV8m`. A seção de troca obsoleta foi removida das Configurações sem adicionar conteúdo/layout; não havia frame Doop aprovado para essa tela, e a captura Electron ficou pendente naquela execução; o proprietário aprovou a E0 após validação manual Windows em 2026-11-08.

### 2.2 Instalação, identidade e CI atuais

- `package.json`: Electron `^45.0.0`, electron-builder `^26.18.0`; versões efetivas vêm do lockfile. Build `--win nsis --x64 --publish never`, ASAR, `appId=com.karaoke.queue`, produto/executável genérico Karaoke Queue, um ICO genérico em `build-resources/`.
- NSIS assistido: `oneClick=false`, `perMachine=false`, `allowElevation=true`, diretório alterável, atalhos Desktop/Start Menu genéricos, `runAfterFinish=false`. Não há estratégia implementada de função por máquina, manutenção por função ou ACL compartilhada. Não tratar `allowElevation` como garantia de instalação para todas as contas.
- `main.ts` obtém `requestSingleInstanceLock()` antes da inicialização operacional; usa `app.getPath('userData')` para bancos, logs, licença e configurações. O lock atual é por perfil; testes permitem perfis diferentes simultâneos. Não garante exclusividade por computador.
- `src/main-window-factories.ts` usa títulos genéricos/Gestão e Reprodutor. Não foi encontrado `setAppUserModelId` no startup auditado. Atalho, janela, taskbar e ícone PE são superfícies distintas.
- `.github/workflows/pr-validation.yml`: já compila/testa Linux, gera NSIS em Windows, verifica pacote, executa smoke e publica artifact de PR por 30 dias; permissões `contents: read`.
- `.github/workflows/release-windows.yml`: dispatch somente em main, valida SHA/SemVer/duplicatas, build e checksum; o job final cria tag e prerelease. **Não é um dispatch de validação sem publicação.** Preservar essas proteções; não acioná-lo nesta tarefa/futuros testes E.
- `scripts/verify-windows-build.cjs`: inspeciona ASAR/metadados/ícone e proíbe qualquer `.node`; a lista mínima atual não cobre todos os assets/preloads Standalone/Welcome. A abordagem de extensão nativa mínima está aprovada em A3, condicionada à comprovação técnica real no Windows/Electron empacotado e aos gates de execução; exige adaptação restrita dessa verificação, sem liberar addons SQLite.
- `tests/packaged-windows-smoke.cjs`: injeta perfil `controller`, inicia `dist/win-unpacked/Karaoke Queue.exe`, verifica trial, IPC, SQLite e restart. Não cobre onboarding limpo, Player nem instalação NSIS. Preservar o caso legado ao ampliar a matriz.

### 2.3 Persistência e recuperação atuais

`database.ts` usa `node:sqlite`, banco operacional schema 6 e catálogo Player schema 3 no snapshot auditado. Preserva WAL, FULL, busy timeout, transações e rejeição de schema futuro; contém migração do JSON legado com marcador próprio. Verificar versões novamente na execução, sem vinculá-las ao SemVer ou à política de licença.

Player abre `player-music-catalog.sqlite` sem tabelas operacionais, com proteções de links/aliases para não atingir `karaoke.sqlite`. Combined usa catálogo no banco operacional. Trocar função **não** copia catálogo de um banco para outro nem altera a sequência Standalone. Biblioteca, preferências, licença e recovery têm arquivos/contratos próprios.

A serialização atual é dentro da aplicação proprietária; SQLite não impede dois processos de aplicar snapshots antigos. Exclusividade deve anteceder abertura de bancos e existir durante todo o lifecycle. Não inferir que `BEGIN IMMEDIATE` coordena autoridades de processos distintos.

### 2.4 Evidência e lacunas desta auditoria

Foram inspecionados código, consumidores, testes, scripts, workflows e documentos citados. Não foram executados compile, testes de aplicação, build, NSIS, interop ou validação humana nesta tarefa documental. Resultados históricos D/C continuam pertencendo às respectivas execuções. A documentação Windows mais recente relata indisponibilidade de interop e restrições de Electron em uma auditoria do launcher; isso não apaga os PASS históricos nem comprova disponibilidade atual.

Os frames `rKUlA0rV8m` e `gFR_COs4VP` estão registrados como aprovados no roadmap. Na elaboração original, não havia ferramenta Doop disponível; após reconexão, uma chamada MCP ao guia respondeu com sucesso, sem inspeção dos frames. Seu status atual, descrição, HTML e imagem ainda devem ser consultados antes de mudanças visuais. Ícones finais seguem sujeitos à referência aprovada. A7 aprovou preferir a interface nativa NSIS para manutenção/erros, com textos e fluxo final ainda sujeitos à validação; não inventar UI personalizada.

## 3. Estratégia E1 — arquitetura aprovada; gate técnico pendente

Atualização pós-S1 em 2026-11-08: a [evidência S1](fase-e-s1-evidencias.md) comprova viabilidade básica N-API nos cenários executados, mas S1 continua PARTIAL: ACL entre contas/integridades, UAC, ramo administrativo e NSIS reais ainda exigem homologação. O proprietário aceitou o [contrato técnico](fase-e-e1-01-contrato-instalacao.md) para desenvolvimento isolado e posteriormente autorizou nominalmente E1-03→E5-03. Essa autorização permite continuar implementação e testes isolados; não transforma S1 ou lotes em PASS. A homologação e aprovação das etapas continuam exigindo as provas reais correspondentes.

As decisões da seção 3.5 foram aprovadas em 2026-11-07. O detalhamento de caminhos, manifesto, ACL, elevação, NSIS e recuperação foi aceito para desenvolvimento isolado, mas a implementação concreta ainda não foi homologada. A1–A7 permanecem inalteradas; alternativas e justificativas permanecem como histórico e não podem substituir silenciosamente as escolhas aprovadas.

### 3.1 Instalação e configuração

1. Instalação única **por máquina**, x64, no diretório protegido de Program Files; manter appId, executável genérico e identidade de upgrade. Não oferecer alternativa per-user no novo instalador. UAC explícito para instalar/manter; operação normal roda sem elevação. Se conservar escolha de diretório, aceitar somente destino local com ACL protegida/ownership validado, nunca pasta modificável por usuário comum para código elevado.
2. Manifesto global em `%ProgramData%\KaraokeQueue\installation.json`, criado em diretório com ACL explícita: SYSTEM/Administrators modificam, usuários autenticados leem. Não depender da ACL herdada de ProgramData. Sem dados operacionais/credenciais nesse manifesto.
3. Campos propostos: versão do contrato, installationId, geração, função confirmada nullable, operação pendente com operationId/geração-base/função-alvo/etapa, estado de identidade aplicada. Caminho instalado vem de registro protegido/instalação validada, nunca de caminho arbitrário enviado pelo Renderer. Somente `player` e `combined` como funções novas.
4. Um manifesto é a autoridade de função. HKLM pode registrar descoberta do produto/uninstall, mas não espelhar uma segunda função independente. `operating-mode.json` legado fica preservado como evidência e perde autoridade apenas mediante adoção aprovada E5.
5. Primeiro launch normal apresenta os dois cartões; confirmação solicita UAC explícito para um ramo administrativo restrito **do mesmo executável**. Esse ramo não abre Renderer, banco, licença, perfil ou playback e não executa parâmetros genéricos. A seleção continua no app, fora do NSIS. Cancelar UAC deixa seleção não confirmada e dados intactos. Reinício após função confirmada nunca pergunta novamente.
6. O ramo administrativo só aceita operações enumeradas e payloads limitados, faz nova leitura/validação e verifica instalação/geração sob exclusão. Não confiar em flag CLI como autorização, nem em nonce como substituto de ACL/UAC. A elevação pode usar broker Windows/PowerShell com argumentos seguros; sem interpolação de shell, scripts de perfil ou bypass de política. Entrada CLI inválida falha antes do bootstrap normal.
7. Biblioteca e CSV continuam sob o usuário que opera o app, pelo segundo frame aprovado, após a função global. Marcar configuração concluída/adiada separadamente da função; CSV é opcional. Em falha entre passos, retomar somente a configuração pendente. Outra conta recebe a mesma função e pode configurar sua biblioteca sem nova escolha de função. A separação operacional por conta está aprovada em A2; o contrato concreto de retomada/setup será verificado em E1-01.

### 3.2 Dados por conta, exclusividade e permissões

Conforme A2 aprovada, manter `userData` e todos os bancos nos caminhos atuais por conta; não tornar SQLite compartilhado apenas para compartilhar a função. Contas diferentes observam a mesma função, mas mantêm sessões/histórico/biblioteca próprios. Compartilhar acervo operacional entre contas é alternativa histórica não aprovada: exige estratégia de acesso/ACL/dados e revisão deste plano antes da implementação. Não copiar perfis na elevação, especialmente ao fornecer credenciais de outro administrador.

Conforme A3 aprovada, E3 implementará exclusividade via mutex Win32 em namespace `Global\`, estável por produto e independente de função, installationId, conta e perfil. Um único gate exclui operação normal e manutenção: ambas adquirem o mesmo recurso; em manutenção concorrente o aplicativo não abre banco e vice-versa. Manter o lock Electron por perfil para o comportamento de segunda instância/foco na mesma sessão. Não tentar focar outra sessão Windows nem terminar processo dela.

O gate deve ser adquirido no Main antes de efeitos operacionais e mantido até fechar recursos; o ramo de manutenção também precisa dele. O nome/ACL não derivam de input do usuário; ACL concede somente os direitos necessários para adquirir/liberar, sem alteração por usuário comum. Testar contas padrão/admin, sessões simultâneas, objeto preexistente incompatível, DACL inválida e abandono. Acesso negado/objeto inesperado bloqueia operação; não usar fallback para lock por perfil.

**Abordagem aprovada, condicionada à comprovação técnica:** preferir binding Windows mínimo N-API, carregado só no Main, para adquirir/liberar o mutex com DACL explícita e manter ownership em thread nativa estável até shutdown. Não transportar handle entre threads sem contrato. Isso adiciona um módulo `.node`, não outro executável de produto, banco, daemon ou serviço. Exige build MSVC/SDK Windows e inspeção do binário no artifact. E1-01 registra viabilidade básica S1 antes do desenvolvimento E1-02 e exige comprovação da integração concreta no candidato para homologação; E3 deverá comprovar a implementação real em Windows/Electron empacotado. Se inviável, parar e apresentar alternativa para nova aprovação, sem substituir por lockfile com PID/timeout.

Alternativas consideradas: serviço/broker Windows permanente aumenta instalação, privilégios e manutenção; helper PowerShell que mantém mutex é mais simples de compilar, mas sua morte pode liberar o gate enquanto o Main ainda grava, exigindo coordenação adicional; lockfile com expiração/PID não resolve atomicidade, PID reutilizado ou recuperação incerta. O binding no processo reduz esse risco de lifecycle. O mutex coordena versões cooperantes; não impede um administrador de adulterar o sistema ou um executável antigo que nunca implementou o gate.

E1-01 detalha o contrato já aprovado e exige aceite limitado/autorização para desenvolvimento E1-02, preservando homologação posterior obrigatória; E3 implementa e comprova a exclusividade. E1/E2 intermediárias não podem ser distribuídas como produto com garantia por computador. O ramo de elevação inicial encerra a composição normal antes de aplicar; E3 adicionará a exclusão global ao protocolo já definido, sem bypass permanente.

### 3.3 Identidade e atalhos

- Preservar `productName`, PE/ícone incorporado e identidade de upgrade genéricos. Usar assets ICO aprovados externos ao ASAR em caminho protegido/estável para atalhos/janelas.
- Título/nome exibido: Reprodutor e Tudo em um, com marca conforme referência aprovada. AppUserModelID proposto: `com.karaoke.queue.player` / `com.karaoke.queue.combined`, aplicado antes de criar janelas e repetido no atalho. Não alterar o appId do pacote por função.
- Atalhos comuns em Public Desktop/Common Start Menu, escritos pelo ramo elevado, apontam ao mesmo exe, sem argumento que escolha função ou perfil. Antes da escolha, somente atalho genérico de bootstrap; depois, somente os atalhos gerenciados da função confirmada. Preservar política de Desktop escolhida na instalação.
- Registrar atalhos gerenciados com destino/identidade; remover somente os comprovadamente pertencentes ao produto. Não apagar atalhos particulares/pins do usuário. Pins antigos podem exigir ação humana; não prometer atualização de todas as superfícies Explorer/taskbar.
- Atualização/repair consulta função global; não deixa o NSIS recriar atalhos genéricos após confirmação. Erro em qualquer superfície obrigatória mantém operação pendente, sem falso sucesso.

Electron expõe `setAppUserModelId` e leitura/escrita de atalhos; suporte documentado não substitui teste do pacote/Windows alvo. Ver [app](https://www.electronjs.org/docs/latest/api/app), [shell](https://www.electronjs.org/docs/latest/api/shell) e [ShortcutDetails](https://www.electronjs.org/docs/latest/api/structures/shortcut-details). A recomendação é uma inferência de arquitetura baseada nessas APIs e no código auditado.

### 3.4 Falhas, manutenção e dados

Controlar operações administrativas por geração e operationId: ler confirmado → validar candidato → persistir intenção privada/pending → aplicar efeitos idempotentes → verificar → publicar geração confirmada. Manifesto usa escrita temporária exclusiva, flush e substituição atômica testada em NTFS, com estado anterior recuperável; validar reparse points/paths/ACL. Não afirmar atomicidade conjunta entre filesystem, atalhos, registro e SQLite.

Após crash: se há pending, bloquear startup operacional e reparar/compensar pela manutenção; nunca escolher função pelo atalho que sobrou. Retry do mesmo operationId consulta o resultado; nova intenção exige novo ID. Geração-base antiga não sobrescreve decisão nova. Timeout/ACK perdido significa resultado desconhecido até reler/verificar, não autorização para repetir toda a operação. Não utilizar timers como coordenação.

Reexecutar o instalador detecta a instalação e oferece Alterar função, preferencialmente na interface nativa NSIS conforme A7 aprovada; textos e fluxo final ainda exigem validação. Solicitar saída normal; aguardar drain/commit e gate disponível. Se usuário cancela ou flush falha, não prosseguir; nada de kill automático ou troca em processo vivo. Integração a “Alterar” em Programas e Recursos é opcional. Desinstalação conserva dados/perfis e registro de função recuperável para reinstalação; descarte de dados exige escopo/autorização próprios.

Não incluir mudança de schema operacional em E apenas por instalar/trocar função. E5 implementa adoção de instalação legada sem mover bancos: inventário, resolução explícita de função, preservação de perfis e desativação controlada da instalação antiga, se aprovada. Instalações legadas em outras contas podem estar invisíveis/inacessíveis: não prometer inventário completo, não assumir exclusividade com elas ativas e não excluir perfis para resolver conflito. Casos não resolvidos ficam bloqueados com orientação específica.

### 3.5 Decisões A1–A7 aprovadas pelo proprietário — 2026-11-07

Aprovação arquitetural explícita registrada pelo proprietário em 2026-11-07. Não significa autorização de execução, lote implementado, teste PASS, etapa concluída ou aceitação visual. A auditoria documental E1-01 foi entregue em 2026-11-08; o aceite limitado para desenvolvimento permanece proposto e a homologação completa pendente, conforme contrato vinculado; comprovação global em Windows/Electron empacotado permanece obrigatória em E3.

| ID | Decisão aprovada | Alternativa histórica não autorizada | Consequência / gate restante |
|---|---|---|---|
| A1 | Instalação única por máquina; UAC explícito na instalação, manutenção e confirmação inicial da função; operação normal sem elevação | Per-user, ou função global gravável por grupo operacional | Per-user sozinho não satisfaz regra entre contas; grupo gravável permite alteração fora da manutenção. Verificar elevação, permissões/ACL e NSIS em E1-01 antes E1-02 |
| A2 | Função global por computador; `userData`, SQLite, históricos, sessões, bibliotecas e configurações operacionais separados por conta Windows; sem compartilhamento/fusão automática de bancos | Dados operacionais compartilhados entre contas | Compartilhar demanda nova decisão e estratégia de acesso/migração. Verificar persistência global protegida, paths por conta e setup/retomada em E1-01 |
| A3 | Exclusividade global via mutex Win32, preferencialmente com binding N-API mínimo; abordagem condicionada à comprovação técnica real no Windows/Electron empacotado | Broker/serviço ou helper supervisionado | Acrescenta toolchain/binário auditável; alternativas acrescentam lifecycle/instalação. Verificar viabilidade em E1-01 e comprovar em E3; inviabilidade exige alternativa para nova aprovação |
| A4 | Um executável genérico com nomes, títulos, ícones, AppUserModelID e atalhos específicos por função; preservar appId e paths de dados | Atalhos somente por conta | Atalhos comuns propostos exigem permissões/ACL verificadas; ativos finais sujeitos à referência aprovada. Confirmar superfícies suportadas, assets, nomes e política Desktop em E2 |
| A5 | Migração legada conservadora; preservar dados/perfis; sem mover, converter, fundir ou excluir automaticamente; conflitos não resolvidos bloqueiam operações potencialmente inseguras | Migração para perfil central ou regra automática de prevalência | Alternativas podem tornar dados inacessíveis/sobrescrever decisões. Detalhar matriz em E1-01, confirmar em E3 e validar em E5, sem presumir inventário completo de outras contas |
| A6 | Backups SQLite consistentes, recuperação segura e bloqueio de downgrade incompatível; restauração que possa descartar dados posteriores exige autorização específica | Garantir downgrade para versões selecionadas com conversor testado | Downgrade universal não é garantível. Verificar recuperação em E1-01 e ensaiar backup/restore em E5; aprovação arquitetural não autoriza restauração concreta |
| A7 | Preferir interface nativa NSIS para manutenção, alteração de função e erros; evitar UI personalizada desnecessária; textos e fluxo final sujeitos à validação | UI personalizada conforme referência própria | A formulação original dependia de referência de manutenção; a decisão atual prioriza páginas nativas NSIS. Verificar suporte em E1-01 e validar textos/fluxo em E4; frames Welcome do app continuam aprovados e obrigatórios |

Decisões técnicas triviais (nomes de testes/helpers, organização local mínima, fixtures sintéticas, semântica de comparação) cabem ao executor autorizado. Mudança das decisões aprovadas que altere privilégios, dados ou experiência exige nova aprovação. A aprovação A1–A7 não substitui verificações técnicas, aceitações visuais/textuais nem autorizações de execução.

## 4. Estratégia de testes e evidência

| Nível | Execução e finalidade | O que não comprova |
|---|---|---|
| T0 | Compile e unit/integration focados; SQLite real em diretório temporário; injeção determinística de falhas | UI de produção, ACL Windows ou NSIS |
| T1 | Electron real Linux/Xvfb, Main/Preload/IPC de produção quando declarado; MP4 real para playback | Windows, taskbar, UAC ou instalador |
| T2 | Runner Windows oficial WSL → checkout NTFS, Node/Electron/Playwright nativos, perfil/banco isolados e fingerprint | Instalação NSIS se apenas iniciar pelo projeto/harness |
| T3 | Build Windows, verificador ASAR e smoke de `win-unpacked` com executablePath | Instalação, repair, uninstall e UAC reais |
| T4 | Instalação/upgrade/manutenção/desinstalação NSIS real em Windows descartável apropriado (runner hospedado nos casos suportados; laboratório/VM remota para os interativos), duas contas/sessões e imagem recuperável; sem exigir VM local | Aprovação visual/humana, áudio e ambiente de estabelecimento |
| T5 | Validação humana no candidato real: UAC/NSIS no ambiente descartável interativo; diálogos/taskbar/A/V e aprovação visual conforme ambiente e autorização próprios | Testes omitidos ou cenários não observados |

PASS exige assertions/resultados/evidências do cenário executado no snapshot declarado. FAIL é falha observada; NOT RUN é não execução/pré-requisito indisponível; PENDENTE é execução/aceite por fazer. Uma etapa com cobertura obrigatória NOT RUN não está tecnicamente encerrada. Não aumentar timeout/retry nem enfraquecer assertions para obter PASS. Não usar `--no-sandbox` ou políticas permissivas para contornar validação.

**Regra pós-S1:** testes obrigatórios de desenvolvimento e de homologação conservam resultados individuais. Dentro de E1, “desenvolvimento validado; homologação pendente” pode habilitar o lote seguinte nominalmente autorizado; não equivale a PASS integral de lote, encerramento/aprovação de E1 ou distribuição. A [matriz da seção 9 do contrato](fase-e-e1-01-contrato-instalacao.md#93-lotes-e-fronteiras-de-continuidade) define quais testes podem avançar isoladamente e a [infraestrutura prevista](fase-e-e1-01-contrato-instalacao.md#94-infraestrutura-de-homologação-sem-vm-local-do-proprietário) mantém todos os casos críticos obrigatórios. FAIL no desenvolvimento ou isolamento incerto interrompe continuidade; NOT RUN crítico de homologação permanece bloqueante para o aceite final.

Para cada execução: registrar commit, diff/fingerprint quando árvore suja, versões efetivas, plataforma, modo produção/harness, perfil temporário, comando, exit code, logs redigidos, screenshots relevantes, limpeza/processos e resultado individual. Artefatos não contêm perfis, bancos operacionais, mídia privada, licença ou segredos.

### Bases de regressão reutilizáveis

- **R-Gestão:** unitários `application`, `persistence`, `database-migration`, `main-management-host`, `main-management-ipc`, `main-management-close`, `management-client`, `main-controller-ipc`; E2Es `persistence`, `ipc-validation`, `management-legacy-import`, `round-robin`, `cadence`, `sessions`, `session-close` e `drag` conforme impacto. Preservar RR por mesa, 2:1 sob elegibilidade/proteções, pins/frozen prefix, conclusão distinta de cancelamento, sessão isolada e `getPlayOrder()` sem escrita.
- **R-Player:** scripts `test:unit:standalone-runtime`, `test:unit:standalone-sequence`, `test:unit:standalone-ipc`, `test:unit:standalone-options`; E2E `standalone-production` com MP4, `standalone-options` se biblioteca/CSV mudar, recovery afetado. Sem abrir banco operacional nem adotar fila Gestão; fila limitada e sem autoplay de recovery incerto.
- **R-Startup:** testes `operating-mode`, `main-ipc-policy`, `main-window-factories`, `main-media-runtime`, `main-player-ipc`; E2Es `operating-modes`, `multi-instance` e smoke empacotado. Ajustar expectativas de função apenas pelo requisito E0/E1, preservando cobertura legada.
- **R-Pacote:** `npm run test:release-workflow`, `node scripts/windows-native-runner.test.cjs`, `npm run build:windows`, `npm run verify:windows-build`, smoke empacotado e inspeção de checksum/metadados/assinatura. Não relatar assinatura a partir de `signed:false` do verificador: consultar Authenticode real.

Usar nomes existentes em `package.json`; unitários individuais podem ser chamados em `build/tests/<nome>.test.js` após um compile compartilhado no lote. Testes novos abaixo são propostas, não comandos já disponíveis. Não rodar a suíte inteira a cada arquivo: unitários do lote → fronteira/E2E afetados → regressão da etapa. Executar suíte abrangente no fechamento E0 e E5 pelo impacto em startup/distribuição.

### Launcher e ambientes

Preservar `scripts/standalone-manual-windows.ps1`: UNC WSL, snapshot atual sincronizado para `E:\KaraokeQueue\manual-windows\checkout`, NTFS obrigatório, perfil persistente escolhido, compile Windows e `package.json.main` real. Sem fallback para C:, harness C1 ou executável velho. Não criar launcher por função.

Estender `scripts/run-windows-native-tests.cjs` somente para modos necessários e reutilizar fingerprint/locks/cleanup; não copiar seu pipeline. Não escrever no checkout Windows durante runner ativo. Testes T4 têm VM/instalação isoladas, sem tocar o Windows operacional do proprietário nem o checkout/perfis do launcher.

Após E3, perfis de desenvolvimento não representam instalações múltiplas de produção: testes sequenciais por padrão. Se preciso, fornecer backend de controle/mutex isolado somente em app não empacotado, com namespace de validação explícito e sem modificar ProgramData real. Não permitir override equivalente em pacote de produção; `--user-data-dir` pode isolar dados, nunca contornar o gate global. Os testes de exclusividade T4 devem usar a autoridade real da VM, sem backend falso.

## 5. Lotes sequenciais

Todos os lotes usam os contratos acima. “Documentar ticket” significa atualizar somente o ticket da etapa, com progresso/evidência/omissões; roadmap muda apenas por status/gate da etapa. Resultado esperado não é resultado já obtido.

### E0-01 — Resolução canônica e compatibilidade

- **Objetivo/escopo:** estabelecer duas funções efetivas e leitura segura de Controller, sem alterar localização, schema ou conteúdo dos dados.
- **Dependências:** autorização E0-01; D aprovada; auditoria atual revalidada.
- **Arquivos prováveis:** `src/operating-mode.ts`, `main.ts`, `types.d.ts`, contratos de modo e `tests/operating-mode.test.ts`.
- **Contratos/invariantes:** parser estrito legado preservado; ausência de modo em perfil legado resolve Gestão; perfil realmente novo mantém onboarding; leitura não grava; Player independente; único host operacional.
- **Implementação:** separar tipo persistido legado de função efetiva; normalizar `controller` na fronteira Main; aceitar gravações novas só das duas funções; adaptar consumidores tipados sem renomeação geral; manter erro em configuração inválida/futura sem apagar arquivo.
- **Testes obrigatórios:** T0 parser/normalização/read-only, JSON inválido/versão futura/link/tamanho, perfil novo versus legado inclusive WAL/recovery; T1 startup de cada função e legado Controller.
- **Regressões:** R-Startup e leitura de sessão rica em SQLite real; mídia ausente/inválida herdada não pode levar a reset de Gestão. Se novo ramo de mídia bloquear perfil antes válido, tratar compatibilidade explicitamente sem ignorar corrupção.
- **PASS/FAIL:** duas funções efetivas; Controller só entrada legada; arquivos não regravados na leitura; mesmo conteúdo lógico SQLite antes/depois sem ação operacional; configuração inválida bloqueia sem side effects. Qualquer terceira opção ou perda de dados é FAIL.
- **Resultado/documentação:** contrato canônico testado; ticket E0 e arquitetura remota com compatibilidade descrita.

### E0-02 — Composição, consumidores e superfícies de produto

- **Objetivo/escopo:** consolidar Gestão Combined e remover Controller selecionável sem antecipar instalador, identidade Windows ou H8.
- **Dependências:** E0-01 PASS, autorização E0-02; consulta Doop antes de visual.
- **Arquivos prováveis:** `main.ts`, `src/main-controller-ipc.ts`, `src/main-player-ipc.ts`, `preload.ts`, `welcome-preload.ts`, `src/welcome-*`, `src/welcome.html`, `src/ui/settings-view.ts`, `src/index.html`, testes de modos/IPC e smoke.
- **Contratos/invariantes:** uma `KaraokeApplication`/writer; mesmos serviços Gestão; nenhuma sequência Standalone no Combined; não introduzir caminho de troca para Controller por CLI/IPC/UI.
- **Implementação:** remover seleções/cópia obsoleta aplicáveis com referência aprovada; fechar canais de troca que reintroduzem Controller; usar capacidades para Gestão; preservar infraestrutura de mídia Combined; adaptar smoke para Combined mais caso legado; manter biblioteca/CSV/onboarding completo para E1.
- **Testes obrigatórios:** T0 autorização/payload/sender e capacidades; T1 Main real para Combined/legado/Player, IPC legado rejeitado onde retirado, initialization única, fechamento enquanto grava e falha de flush; comparação Electron/Doop das superfícies alteradas a 1280×800.
- **Regressões:** R-Gestão, R-Player e catálogo/recovery no Combined; testar que renderer não ganha FS/SQL nem função administrativa.
- **PASS/FAIL:** apenas Player/Combined como opções finais; Gestão íntegra e uma única autoridade; handlers não concedem bypass; diferenças visuais significativas corrigidas ou lote pendente.
- **Resultado/documentação:** consolidação funcional; ticket E0, arquitetura e documentação dos modos; preservar nomes internos úteis.

### E0-03 — Campanha e fechamento da consolidação

- **Objetivo/escopo:** validar a consolidação como baseline anterior a E1, sem instalar arquitetura nova.
- **Dependências:** E0-02 PASS e autorização E0-03.
- **Arquivos/componentes:** testes de modos/Gestão/Player, runner e launcher existentes; mudanças de teste somente por necessidade demonstrada.
- **Contratos/invariantes:** compatibilidade legada e persistência confirmada; nenhum código E1–E5.
- **Implementação:** completar cenários ausentes, executar campanha abrangente pertinente, inspecionar diff e capturas; manter smoke legado e validar fluxo novo; registrar limitações reais.
- **Testes obrigatórios:** compile, unitários pertinentes abrangentes, R-Gestão/R-Player/R-Startup; T2 Windows nativo oficial de modos/Gestão/Standalone com MP4 e SQLite isolados; T3 pacote/verify/smoke.
- **Regressões:** trial/ativação, import legado, sessões, prioridades, shutdown/commit perdido e recovery; nenhum catálogo/banco convertido pelo alias.
- **PASS/FAIL:** todos os cenários obrigatórios executados e PASS, diff dentro de E0 e evidência de produção versus harness identificada. NOT RUN mantém validação pendente.
- **Resultado/documentação:** relatório E0 pronto para aceite; ticket/roadmap só recebem encerramento após aprovação explícita. Parar antes de E1.

### E1-01 — Contrato de instalação e gate da estratégia

- **Objetivo/escopo:** verificar e detalhar a estratégia técnica concreta sob A1–A7 já aprovadas, incluindo viabilidade, implementação concreta, permissões/ACL, NSIS, N-API e recuperação antes de liberar E1-02.
- **Dependências:** E0 concluída/aprovada; auditoria E1-01 entregue; S1 PARTIAL. O proprietário aceitou o detalhamento somente para desenvolvimento isolado e autorizou E1-02 em 2026-11-08. A homologação E1 permanece pendente.
- **Arquivos/componentes:** este plano, ticket E1, `package.json`/lock, templates NSIS da versão instalada, runner/workflows e documentação; somente auditoria/documentação neste lote.
- **Contratos/invariantes:** nenhuma instalação/migração/exclusividade implementada por consequência da pesquisa.
- **Passos:** confirmar versões efetivas/limites NSIS, upgrade code e locais HKCU/HKLM; inventariar cenários legados sem abrir bancos reais para escrita; definir matriz de ACL/identidade/operação pendente e contratos CLI; verificar viabilidade MSVC/N-API no Windows/Electron alvo, UAC, mutex e páginas nativas NSIS, além da implementação concreta e cenários de recuperação; registrar evidência e lacunas. Preservar A1–A7; inviabilidade exige alternativa para nova aprovação, sem substituição silenciosa. S1 mantém suas obrigações no ledger antes da homologação; desenvolvimento pode ser autorizado sob o gate limitado, sem início automático de E1-02.
- **Testes obrigatórios:** inspeção estática reproduzível dos templates e configurações; matriz de casos com expectativa observável; evidência S1 por caso PASS/FAIL/NOT RUN, com projeto e dados sintéticos em ambiente Windows isolado. A execução parcial atual não substitui ACL entre contas/integridades, UAC, branch administrativo ou handoff NSIS. Sem suíte da aplicação por ser auditoria/spike isolado.
- **Regressões:** conferir que proposta não troca appId, compartilha banco, cria terceiro produto ou enfraquece licenciamento.
- **PASS/FAIL:** o aceite limitado e a autorização E1-02 foram obtidos; isso liberou somente desenvolvimento isolado com S1 PARTIAL. Não encerra o gate de homologação: todas as obrigações críticas S1/E1 devem receber comprovação real no candidato relevante antes do aceite E1, com ledger de evidências e sem promover NOT RUN a PASS. Exclusividade operacional permanece obrigatória em E3.
- **Resultado/documentação:** contrato E1-01, relatório de evidências S1, ticket E1 e este plano sincronizados. Atualizar `windows-release-process.md`/`sqlite-persistence-safety.md` somente após estratégia aceita e contratos implementados/verificados.

### E1-02 — Controle global e ramo administrativo mínimo

**Ajuste pós-S1:** incluir binding mínimo/empacotamento para lock administrativo mediante aceite limitado do contrato e autorização nominal. S1 integral PASS não é pré-requisito para escrever/testar o candidato; as lacunas críticas impedem homologação, aprovação E1 e distribuição. Exclusão operacional permanece E3; seguir seções 4–10 do [contrato](fase-e-e1-01-contrato-instalacao.md). Implementação local iniciada em 2026-11-08; status de execução e evidência estão abaixo e no ticket E1.

- **Objetivo/escopo:** persistência de função/estado de onboarding e contrato de elevação, conforme estratégia aprovada; exclusividade definitiva só E3.
- **Dependências:** aceite explícito do detalhamento E1-01 **limitado ao desenvolvimento isolado** e autorização nominal E1-02, ambos registrados; pré-flight usou somente diretórios/perfis/SQLite sintéticos. A1–A7 e a autorização E1-02 não autorizam outro lote.
- **Arquivos/componentes:** `main.ts` como bootstrap, `main-runtime.ts` para composição carregada sincronicamente somente depois do gate (preservando registro de protocolo e lock antes de `app.ready`), `src/installation-control.ts`, `src/installation-bootstrap.ts`, `src/installation-admin-args.ts`, `src/installation-admin.ts`, `src/installed-role-context.ts`, addon em `build-resources/native/`, hook/allowlist PE e smoke empacotado com fixtures sintéticas.
- **Contratos/invariantes:** manifesto global único; ACL protegida; normal startup sem privilégio; ramo elevado sem abrir userData/SQLite/licença; nenhuma API FS/exec genérica ao Renderer.
- **Implementação:** dispatch administrativo antes da composição operacional; aceitar somente `confirm-initial` com UUID/geração/função, mutex admin global e contexto elevado; manifesto ProgramData estrito com `pending`, replace atômico, idempotência e nova checagem de ACL/owner após cada replace; startup empacotado lê somente função global confirmada, enquanto cada conta conserva seu `userData`; build x64 Node-API v8 via `beforePack`, recurso fora do ASAR e verificador que só permite esse addon; manifesto ausente/corrupto/pending bloqueia fechado. O bootstrap valida função sincronicamente e carrega a composição antes de `app.ready`, preservando o registro do protocolo de mídia e o lock de instância existentes. A UI ainda não invoca o broker, e não existe troca de função ou exclusividade operacional nesta etapa. O broker UAC/onboarding pertence a E1-03; NSIS per-machine e instalação permanecem E1-04. O bootstrap não ativa fallback local no pacote.
- **Testes obrigatórios:** T0 arquivos reais temporários, escrita negada, falha em flush/rename, arquivo inválido/reparse, crash antes/depois da publicação, ACK perdido/operationId repetido e geração obsoleta; T2 nativo seguro e Electron real com perfis sintéticos no desenvolvimento; ACL efetiva entre contas/integração administrativa real são homologação em Windows descartável autorizado. UAC no secure desktop, cancelamento e credenciais de outra conta são T4/T5: verificar em ambiente remoto/laboratório descartável interativo com operador, sem alegar que Playwright controla o prompt nativo.
- **Regressões:** R-Startup; não abrir perfil do administrador nem criar autoridade operacional em execução administrativa.
- **PASS/FAIL:** desenvolvimento só passa com T0, Electron Main/Renderer e addon/candidato Windows seguros executados; ACL/UAC entre contas reais fica registrada no ledger até homologação. T0, compile, suítes unitárias/regressões, teste do build-hook e testes de configuração passaram. O E2E Electron terminou antes de iniciar (Playwright `Process failed to launch`; diagnóstico direto anterior: `sandbox_host_linux.cc:41 / Operation not permitted`). O runner Windows encerrou no preflight antes da sincronização (`UtilBindVsockAnyPort:307: socket failed 1`). Logo Electron real, addon/build nativo e smoke empacotado são NOT RUN; E1-02 permanece com validação obrigatória incompleta e E1-03 não está tecnicamente pronta. Para homologação, somente estado confirmado é utilizável; falhas preservam anterior/pending recuperável; usuário comum lê e não altera autoridade; nenhum caminho de privilégio genérico. Ainda não declarar exclusividade por computador.
- **Resultado/documentação:** implementação local registrada no ticket e no [contrato E1-01](fase-e-e1-01-contrato-instalacao.md); `windows-release-process.md` atualiza hook/build e fixture do smoke. S1 continua PARTIAL. Naquele snapshot de E1-02, E1-03 ainda não estava autorizada e os testes obrigatórios de desenvolvimento permaneciam NOT RUN; esse estado de autorização foi posteriormente substituído pela autorização global, sem alterar os resultados dos testes nem considerar E1-02 aprovada. A execução autorizada continuou em lotes independentes e o ledger da seção 12 registra o estado atual.

**Evidências E1-02 (2026-11-08):** `npm run compile` e `npm run test:unit` PASS; `npm run test:unit:installation-control` PASS (inclui manifesto/admin/bootstrap e hook); `npm run test:release-workflow` PASS (dois arquivos de teste); `node scripts/packaging-config.test.cjs` PASS (4/4); `node --check tests/packaged-windows-smoke.cjs` PASS; `git diff --check` PASS após revisão. `npm run test:e2e:operating-modes:headless` foi executado, mas Electron não iniciou (Playwright `Process failed to launch`; diagnóstico direto anterior: `sandbox_host_linux.cc:41 / Operation not permitted`), então cenário Electron é NOT RUN. Runner Windows oficial encerrou no preflight antes de sync/build/teste (`UtilBindVsockAnyPort:307: socket failed 1`). Compilação/carga do addon atual, build/verificador Windows, smoke empacotado, ACL efetiva, UAC e NSIS ficam NOT RUN. Sem instalação, elevação, workflow, artifact ou alteração de dados operacionais.

### E1-03 — Onboarding de duas funções e configuração inicial

- **Objetivo/escopo:** aplicar os dois frames aprovados ao fluxo real, persistência sem repetição e bloqueio de troca normal restante.
- **Dependências:** testes obrigatórios de desenvolvimento E1-02 PASS, pendências de homologação registradas e autorização E1-03; Doop consultado com HTML/render/status/descrição de `rKUlA0rV8m` e `gFR_COs4VP`.
- **Arquivos prováveis:** `src/welcome.html`, CSS/renderer Welcome, `welcome-preload.ts`, `main.ts`, serviços de biblioteca/catálogo e respectivos IPC; `src/main-player-ipc.ts`/Settings remanescentes; testes produção/modos.
- **Contratos/invariantes:** exatamente Reprodutor/Tudo em um; seleção fora NSIS; biblioteca adiável, CSV opcional; sem mudança em Settings; falha/cancelamento sem mutação de fila/banco.
- **Implementação:** conectar os passos ao controle confirmado; reutilizar Main-side biblioteca/CSV sem parser duplicado; estados de função versus setup separados; retorno de diálogo/falha tratado; fechar rotas antigas de troca; recuperar passo interrompido sem repetir função confirmada.
- **Testes obrigatórios:** T0 validação IPC/concorrência de confirmação; T1/T2 produção real: ambas funções, adiar, CSV ausente/inválido, mídia inacessível, restart entre passos e cancelamento simulado do broker no desenvolvimento; screenshots comparados ao Doop em mesma dimensão. Homologação T4/T5 acrescenta cancelamento UAC real e setup por segunda conta conforme A2, sem substituir por adapters.
- **Regressões:** R-Player/opções/catálogo e Gestão após onboarding; CSP, foco/teclado e sender/subframe inválido.
- **PASS/FAIL:** continuidade de desenvolvimento exige testes isolados e visuais aplicáveis PASS; contas/UAC reais ausentes permanecem NOT RUN. Homologação exige também esses cenários reais; duas opções e dois passos corretos; restart/update não repetem função; adiar não bloqueia app; APIs antigas não trocam função; visual comparado sem divergência significativa. Diálogo substituído por porta de teste não vale como teste nativo.
- **Resultado/documentação:** onboarding integrado; ticket E1, UI plan e documentação de biblioteca/catálogo somente no que mudou.

### E1-04 — NSIS único e artifacts de validação

- **Objetivo/escopo:** empacotar o fluxo aprovado e produzir NSIS em PR/dispatch sem publicação; reutilizar pipeline existente.
- **Dependências:** testes obrigatórios de desenvolvimento E1-03 PASS, pendências de homologação registradas e autorização E1-04. O binding administrativo já deve ter sido introduzido/testado isoladamente em E1-02; a prova privilegiada completa permanece na homologação; sua ativação operacional fica em E3-01.
- **Arquivos prováveis:** `package.json`, lock se necessário, include NSIS mínimo em `build-resources/`, `.github/workflows/pr-validation.yml`, `scripts/packaging-config.test.cjs`, `scripts/release-workflow.test.cjs`, `scripts/verify-windows-build.cjs`, `tests/packaged-windows-smoke.cjs`.
- **Contratos/invariantes:** mesmo exe/appId; sem seleção de função NSIS; `--publish never`; nenhuma credencial real de assinatura; preservar o publisher manual atual.
- **Implementação:** configurar instalação por máquina aprovada/ACL/bootstrap, preferindo includes/hooks ao script NSIS completo; preservar runAfterFinish false; ampliar verificação Welcome/Standalone/preloads/assets; smoke de perfil limpo e funções finais mais legado. Adicionar `workflow_dispatch` ao workflow de validação atual, ajustando nome artifact para PR versus run_id/SHA; sem duplicar build em workflow novo. Reusar steps Windows e manter release separado.
- **Testes obrigatórios:** T0 configuração de ambos eventos/permissões e ausência de publicação; T3 build/ASAR/smoke em Windows; T4 instalação limpa real sem escolha no NSIS, entrada de uninstall, ACL e primeiro launch. CI read-only publica instalador, SHA256SUMS e manifesto com SHA exato (merge SHA de PR identificado), versões e resultados; confirmar conteúdo após download.
- **Regressões:** R-Pacote; testes do publisher original intactos; artifacts falhos não rotulados como validados; evitar `pull_request_target`/secrets para código de fork.
- **PASS/FAIL:** desenvolvimento pode validar build/inspeção/configuração sem instalar no host; smoke operacional completo e T4 indisponíveis ficam NOT RUN. Homologação exige um instalador x64, archive completo/limpo, smoke e instalação reais PASS; artifact rastreável por hash/SHA e sem Release/tag; dispatch de validação não chama publisher. Não executar dispatch sem autorização específica.
- **Resultado/documentação:** pipeline/NSIS testados e pacote intermediário identificado sem garantia E3; ticket E1 e release Windows. Encerramento E1 exige aceite antes E2.

### E2-01 — Identidade Windows e assets aprovados

- **Objetivo/escopo:** implementar títulos/ícones/AppUserModelID por função sem modificar PE ou dados.
- **Dependências:** E1 concluída/aprovada e autorização E2-01; A4 já aprovada, ativos visuais finais ainda sujeitos à referência aprovada.
- **Arquivos prováveis:** `src/main-window-factories.ts`, `main.ts`, módulo local de identidade, `build-resources/`, copy-assets/empacotamento e testes de factories/pacote.
- **Contratos/invariantes:** mesmo exe e appId; função vem do manifesto; setAppUserModelId antes de janelas; sem inferir função a partir do atalho.
- **Implementação:** mapear função → identidade aprovada em uma tabela; assets estáveis externos ao ASAR; aplicar janela/taskbar e propriedades de shortcut; validar paths de instalação e assets; não renomear userData por mudar nome exibido.
- **Testes obrigatórios:** T0 tabela/factory/paths e assets faltantes; T3 pacote real de cada função, título/ícone/AppUserModelID; T2 capturas comparadas a referência e registro das superfícies verificáveis.
- **Regressões:** R-Startup/Player vídeo fullscreen, Gestão; restart mantém mesmo banco/perfil/licença.
- **PASS/FAIL:** identidade aprovada aplicada em superfícies suportadas e verificadas; exe permanece genérico; paths de dados intactos. Taskbar/pins sem evidência ficam pendentes, não PASS por inferência.
- **Resultado/documentação:** mapeamento/limites comprovados; ticket E2 e release/UI plan afetados.

### E2-02 — Atalhos, reparo e preservação em update

- **Objetivo/escopo:** apenas atalhos gerenciados da função confirmada, com falha recuperável.
- **Dependências:** E2-01 PASS e autorização E2-02.
- **Arquivos prováveis:** módulo de identidade/controle administrativo, include NSIS, verificador e novos testes Windows de atalhos.
- **Contratos/invariantes:** escopo comum aprovado, sem fallback por usuário; nunca remover link/pin alheio; não publicar identidade antes de verificar.
- **Implementação:** aplicar/reler propriedades de link, atualizar manifesto de ownership, retirar bootstrap somente após sucesso, reparar idempotentemente; desativar recriação genérica pelo instalador em update; erro deixa pending.
- **Testes obrigatórios:** T0 simular falha após criar/antes de remover/verificar; T3/T4 ler destino, args, ícone, AUMID, Desktop/Start Menu nas duas funções; repair/reinstalação sem duplicatas e com acesso negado.
- **Regressões:** shortcut particular/pin preservado; configuração Desktop respeitada; restart e dados intocados.
- **PASS/FAIL:** inventário de links gerenciados corresponde exatamente à função e política aprovada; recuperação converge sem duplicatas; permissões negadas não geram sucesso falso.
- **Resultado/documentação:** identidade/atalhos recuperáveis; ticket E2, release Windows; validação taskbar humana e aceite E2 antes E3. Teste de troca completa espera E4.

### E3-01 — Gate global no processo e empacotamento nativo

**Ajuste E1-01:** reutilizar o binding administrativo introduzido em E1-02 e ativar/comprovar o gate operacional global; não redescobrir a toolchain nem criar segundo addon. NSIS e ramo administrativo usam a mesma ordem de locks/pending do [contrato](fase-e-e1-01-contrato-instalacao.md).

- **Objetivo/escopo:** implementar exclusão por computador conforme A3, incluindo Main normal e ramo administrativo.
- **Dependências:** E2 concluída/aprovada, autorização E3-01; contrato E1 aprovado e reconfirmado.
- **Arquivos prováveis:** binding Win32 mínimo/fontes/build, adapter Main, `main.ts`, scripts de build Windows, pacote/ASAR unpack/verify e testes do gate/runner.
- **Contratos/invariantes:** gate antes de banco/recursos; mesmo nome em todas contas/perfis/funções/maintenance; ownership até recursos fechados; zero API nativa exposta ao Renderer.
- **Implementação:** adquirir mutex em thread proprietária com DACL explícita, wait não bloqueante para rejeição/resultado conhecido; representar abandono sem inventar estado consistente; integrar lifecycle e manutenção; manter lock Electron de perfil; pacote carrega somente binding esperado, caminhos protegidos e arquitetura correta; permitir `.node` por allowlist exata/hash/origem, mantendo vedação de addon SQLite e de outros módulos.
- **Testes obrigatórios:** T0 adapter estados/falhas e ordem antes dos efeitos; T2/T3 binding real x64: acquire/release, ownership/thread, crash/abandoned, DACL/objeto inválido, carga falha, fechamento com flush rejeitado; `--user-data-dir` não contorna gate do pacote. Regressão do runner com namespace isolado não empacotado.
- **Regressões:** R-Startup, shutdown Gestão/Player, smoke N-API no Electron efetivo; Windows sem pré-requisito runtime não baixa dependências nem degrada para lock por perfil.
- **PASS/FAIL:** exclusão observada sem janela de writer duplo; erro nativo bloqueia abertura; nenhuma liberação antes do fechamento; módulo inspecionado no artifact; Linux/dev não fingem PASS Windows.
- **Resultado/documentação:** mecanismo global testado; ticket E3, release, SQLite safety e native testing. Se binding inviável, registrar bloqueio/revisar A3 antes de trocar mecanismo.

### E3-02 — Contas Windows, concorrência e adoção segura

- **Objetivo/escopo:** comprovar escopo real da exclusividade/permissões e confirmar a matriz de legado/migração para E5.
- **Dependências:** E3-01 PASS e autorização E3-02; VM descartável com duas contas/sessões reais.
- **Arquivos/componentes:** testes Windows/NSIS novos integrados ao runner onde adequado, gate/controle, documentação de matriz legada.
- **Contratos/invariantes:** mesma função em todas contas, um operador/maintenance ativo; dados por conta preservados; processo antigo não cooperante é conflito conhecido, não exclusividade garantida.
- **Implementação:** fechar lacunas detectadas; identificar instalação comum versus legada/per-user, sem varrer/apagar perfis; registrar política para conflitos inacessíveis; testar processos simultâneos/instaladores; confirmar estratégia E5 com proprietário se inventário revelar novo caso material.
- **Testes obrigatórios:** T4 dois logons simultâneos, fast-user-switch/RDP disponível, padrão/padrão e padrão/admin, seleção simultânea, app versus maintenance e dois installers, reboot/crash/relaunch, ACL adulterada e caminhos reparse; testes de generation/operationId com ACK perdido e resultados incertos.
- **Regressões:** perfil diferente deixa de permitir duas autoridades no pacote por requisito aprovado; manter teste de isolamento com backend dev restrito; foco da segunda instância apenas na mesma sessão; nenhum acesso a dados da outra conta.
- **PASS/FAIL:** no máximo um proprietário em todos os interleavings testados; função global consistente; conta sem permissão não altera manifesto/atalho; ausência de acesso não cria instalação alternativa. Cenário sem segunda sessão real é NOT RUN.
- **Resultado/documentação:** evidência de exclusividade e matriz aprovada para E5; ticket E3/roadmap/native testing; aceite E3 antes E4.

### E4-01 — Fluxo de manutenção e troca confirmada

- **Objetivo/escopo:** reexecutar o mesmo instalador para Alterar função com encerramento seguro, identidade e dados preservados.
- **Dependências:** E3 concluída/aprovada e autorização E4-01; A7 já aprovada, suporte das páginas NSIS verificado e textos/fluxo final validados antes do aceite.
- **Arquivos prováveis:** include NSIS, ramo administrativo/manifesto, coordenadores Main de fechamento apenas se necessário, módulo de identidade e testes de manutenção.
- **Contratos/invariantes:** nenhuma troca em Configurações; mutex comum impede mutação com app ativo; não encerrar sessão operacional implicitamente; sem kill; função anterior confirmada até conclusão verificada.
- **Implementação:** detectar instalação existente e oferecer manutenção/alteração/erros preferencialmente pelas páginas nativas NSIS, evitando UI personalizada desnecessária; submeter textos e fluxo final à validação. Orientar/request saída normal; manter manutenção fora do writer operacional; adquirir gate após saída, revalidar geração, aplicar operação com pending/identidade, confirmar; relançar sem elevação somente de forma segura ou instruir abertura normal, nunca abrir app operacional como administrador por herança.
- **Testes obrigatórios:** T0 operação/idempotência/geração, T4 Player → Combined → Player, cancelar, app ativo em outra conta, flush falha, sessão aberta e recovery pendente; capturas Windows do fluxo real.
- **Regressões:** bancos das duas funções, trial/licença, preferências/biblioteca/CSV e recovery comparados antes/depois; nenhuma seleção no install limpo; sem segunda instalação.
- **PASS/FAIL:** troca apenas por maintenance, app fechado com confirmação, atalhos/função coincidem ao reiniciar, dados anteriores recuperáveis sem conversão; app ativo/erro de flush impede troca.
- **Resultado/documentação:** manutenção funcional; ticket E4, release e roteiro manual.

### E4-02 — Recuperação de manutenção interrompida

- **Objetivo/escopo:** tornar cada fronteira da troca/repair recuperável sem falsa conclusão.
- **Dependências:** E4-01 PASS e autorização E4-02.
- **Arquivos prováveis:** controle/identidade/NSIS e testes de falha; evitar alterar regras operacionais.
- **Contratos/invariantes:** pending bloqueia operação normal quando função/identidade incertas; retry de uma intenção difere de nova troca; sem exclusão de evidências.
- **Implementação:** completar reconciliação por etapa durável; compensar só efeitos gerenciados verificáveis ou concluir mesma intenção; estado ambíguo exige reparo explícito; não marcar pronto pela mera ausência de processo.
- **Testes obrigatórios:** T0 falha/ACK perdido após cada write, replace de link e confirmação; T4 interrupção real do instalador/ramo administrativo em VM, acesso negado, disco insuficiente controlado e reboot; retomar mesmo operationId versus nova intenção.
- **Regressões:** Ctrl+C/cancelar/UAC negado preservam anterior; recovery playback incerto sem autoplay; sem locks órfãos artificiais removidos por timeout.
- **PASS/FAIL:** recuperação converge ao estado anterior ou novo confirmado e verificado; caso irresolúvel bloqueia com dados/evidência preservados; nenhuma combinação silenciosa de função/atalho divergente.
- **Resultado/documentação:** matriz de falhas com resultado por fronteira; ticket E4 e procedimento de recuperação; aceite E4 antes E5.

### E5-01 — Backup consistente e contrato de upgrade/rollback

- **Objetivo/escopo:** proteger dados antes de adoção/migração autorizada e demonstrar restauração, sem downgrade automático.
- **Dependências:** E4 concluída/aprovada, autorização E5-01; A5/A6 aprovadas e contrato confirmado em E3.
- **Arquivos prováveis:** `database.ts`/camada owning de backup se necessário, controle de instalação e fixtures/testes de migrations/recovery; não elevar NSIS a writer de SQLite.
- **Contratos/invariantes:** WAL/FULL/transactions e preparação → persistência → publicação; schemas independentes de SemVer; backup não altera original nem zera trial.
- **Implementação:** inventariar bancos/arquivos e schemas em acesso seguro; backup SQLite consistente por API disponível em `node:sqlite` da versão efetiva ou `VACUUM INTO` na camada owning, com bloqueio de operações para conjunto coerente; validar integridade/reabertura e manifestar origem/schema/checksum. Para imagem forense após crash, preservar conjunto SQLite/WAL/journal sem copy concorrente; não tratar cópia isolada do `.sqlite` aberto como backup. Não alterar schema só para criar backup.
- **Testes obrigatórios:** SQLite real com commits em WAL, trigger/falha de transação, snapshot e reopen, backup truncado/espaço insuficiente, schema futuro, catálogo Player protegido contra alias; teste de restauração em destino novo com hashes/estado lógico e `integrity_check`/FK aplicável.
- **Regressões:** sessões com dois cantores/duas músicas, cancelado versus concluído, pins/frozen, catálogo/biblioteca/recovery e trial intactos.
- **PASS/FAIL:** snapshot consistente e restaurável comprovado; falha não publica backup completo/migração concluída; schema incompatível bloqueia. Instalar exe anterior não satisfaz critério de rollback.
- **Resultado/documentação:** ferramenta/contrato de proteção testado; ticket E5, SQLite safety e release com limites/retensão sem apagar backups automaticamente.

### E5-02 — Update, reinstall e adoção legada

- **Objetivo/escopo:** aplicar matriz aprovada de versões e instalações sem perda/duplicação de autoridade.
- **Dependências:** E5-01 PASS e autorização E5-02; artifacts de origem e destino identificados, cenários destrutivos somente em VM.
- **Arquivos prováveis:** include NSIS, controle de instalação/startup, backup owning e testes Windows de upgrade/legado; mudanças em migrations só por necessidade aprovada.
- **Contratos/invariantes:** update conserva função/installationId e não repete onboarding; userData/bancos não mudam de dono/path; histórico e recovery preservados; instalação antiga não permanece autoridade paralela.
- **Implementação:** tratar mesma versão/reinstall, versão anterior suportada → atual, modo legado Controller/Combined/Player, perfil legado sem configuração e conflitos de contas; adotar função após inventário/decisão aprovada, conservar JSON legado; desativar instalação antiga somente com autorização/ownership comprovados e sem excluir dados. Banco ausente não significa autorização para substituir outro perfil; conflito inacessível bloqueia e é reportado.
- **Testes obrigatórios:** T4 install/update/reinstall/uninstall preservando dados/reinstall, caminhos com espaços/Unicode, duas contas, perfil sem acesso, biblioteca em volume ausente, pending administrativo e recovery; repetir update sem efeito duplicado. N-1 deve ser artifact real identificado; não trocar só `version` para fingir versão antiga. Se ausente, cenário NOT RUN até obtê-lo.
- **Regressões:** catálogo isolado e operacional distintos, schemas futuros recusados, função global divergente de JSON legado conforme adoção aprovada, licença/trial sem reinício, links corretos e nenhum processo antigo ativo.
- **PASS/FAIL:** matriz obrigatória executada com estado antes/depois consistente, sem conversão/fusão/exclusão implícita; descoberta ambígua bloqueia; instalação legada não desativada impede afirmar exclusividade nesse cenário.
- **Resultado/documentação:** matriz de compatibilidade suportada com evidência/artifacts; ticket E5, release, legacy compatibility e native testing.

### E5-03 — Recuperação completa, revisão independente e aceite E

- **Objetivo/escopo:** fechar riscos de rollback/upgrade interrompido, inspecionar artifacts e preparar aceite proprietário sem iniciar F.
- **Dependências:** E5-02 PASS e autorização E5-03; revisão independente da implementação explicitamente incluída neste lote.
- **Arquivos/componentes:** suites e documentação E, artifact NSIS final e manifestos de evidência; nenhuma feature nova.
- **Contratos/invariantes:** restauração não sobrescreve dados pós-backup silenciosamente; revisão independente não aprova produto pelo proprietário; nenhuma publicação/tag/commit implícitos.
- **Implementação:** executar matriz de falhas abaixo; gerar candidato final pelo pipeline autorizado; revisar diff/código/tests com revisor independente em contexto separado (outro agente read-only ou pessoa, sem autoria da implementação); resolver achados e repetir só verificações afetadas; baixar e inspecionar artifact exato; reunir checklist humano.
- **Testes obrigatórios:** T0/T1 regressão abrangente R-Gestão/R-Player/R-Startup; T2 Windows oficial; T3 build/verify/smoke final; T4 instalação/maintenance/update/rollback selecionados de ponta a ponta no mesmo candidato; T5 proprietário após automação viável. R-Pacote e testes de workflows/runner obrigatórios.
- **Regressões:** falha em backup, replace binário, migração, commit de manifesto, update de atalho e relaunch; kill/reboot em VM; downgrade incompatível; backup anterior mais gravação posterior; reexecução após ACK perdido; cleanup/processos/gate.
- **PASS/FAIL:** nenhuma falha crítica/alta em aberto; nenhuma validação obrigatória omitida tratada como PASS; artifacts e testes ligados ao mesmo SHA/fingerprint; proprietário aprova E explicitamente. Limitações de superfície não suportada precisam de aceitação específica, nunca garantia inventada.
- **Resultado/documentação:** relatório final independente, inventário de artifacts/checksums, checklist manual e tickets E/roadmap atualizados por fatos; E encerrada somente conforme seção 9. F continua não iniciada.

## 6. Sequência, custo e dependências

```text
E0-01 → E0-02 → E0-03 → aceite E0
  → E1-01/S1 PARTIAL → aceite limitado para desenvolvimento
  → E1-02 → E1-03 → E1-04 [candidato]
  → homologação real E1 sem lacunas críticas + aceite E1
  → E2-01 → E2-02 → aceite E2
  → E3-01 → E3-02 → aceite E3
  → E4-01 → E4-02 → aceite E4
  → E5-01 → E5-02 → E5-03 → aceite Fase E
```

As seções 7 e 9 do contrato E1-01 definem ajustes, independências e provas reais por lote. O proprietário autorizou explicitamente o desenvolvimento sequencial de E1-03 a E5-03; não é necessária autorização nominal entre esses lotes. Dependências técnicas continuam válidas: não avançar sobre FAIL, risco de dados ou gate de segurança impeditivo; continuar trabalho independente quando um teste ambiental estiver NOT RUN. Nenhuma seta implica aceite de etapa. As obrigações S1 restantes continuam no ledger de homologação sem perder status/evidência; S1 conserva PARTIAL até comprovação real.

São 16 lotes, mantidos dentro dos seis tickets existentes. A1–A7 continuam aprovadas; a autorização atual cobre somente desenvolvimento, enquanto gates técnicos, homologação e aceitação visual/textual continuam. Dependências adicionais: consultar Doop antes de cada superfície visual/ativo; E1-01 antes do controle/onboarding; viabilidade básica A3 antes do binding e comprovação completa antes da homologação correspondente; referência A4 antes da identidade; matriz/recuperação A5/A6 antes de adoção/restore; Windows descartável com duas contas/sessões e artifacts antigos antes da campanha correspondente, sem exigir VM local do proprietário. CI existente é reutilizada, sem criar pipeline por função; launcher e runner permanecem compartilhados.

Cada lote deve caber em uma mudança revisável com testes focados. Não pulverizar campos/arquivos em microtarefas. Compilar uma vez antes de um grupo de testes unitários quando não há mudança intermediária; ampliar testes na fronteira e nos fechamentos. Evitar paralelismo de builds/perfis/Windows checkout. Revisão independente final é read-only; qualquer delegação intermediária requer escopo útil e ownership exclusivo, sem agentes simultaneamente alterando os mesmos arquivos.

### Riscos prioritários e resposta

| Risco | Detecção e resposta | Lote responsável |
|---|---|---|
| Alias legado ativa mídia antes ausente e impede Gestão válida | Fixtures com biblioteca/recovery inválidos e startup real; preservar estado, resolver compatibilidade sem esconder corrupção | E0-01/02 |
| Elevação abre perfil do administrador ou executa input livre | Ramo administrativo antes do bootstrap, contrato enumerado, paths protegidos, teste com outra credencial; revisão de segurança | E1-02 |
| Identidade muda o nome efetivo de userData | Assert de caminho antes/depois, restart e dados ricos; não usar nome exibido como diretório | E2-01 |
| N-API/toolchain incompatíveis com Electron empacotado | Build x64 Windows e smoke no Electron efetivo; falha bloqueia E3, sem fallback silencioso | E3-01 |
| Objeto global malicioso/ACL insuficiente ou thread proprietária errada | Teste de preexistência/DACL/thread/crash; fail closed; revisão independente dos direitos mínimos | E3-01/02 |
| Legado de outra conta ignora o gate | Inventário/credenciais e desativação aprovada em VM; bloquear migração inconclusiva e não prometer garantia contra binário antigo | E3-02/E5-02 |
| Interop/sessão gráfica/segunda conta ou artifact antigo indisponível | Pré-flight oficial; registrar NOT RUN e manter campanha pendente, sem substituir por harness ou versão fictícia | E0-03/E3-02/E5-02 |
| NSIS e função confirmada divergem após crash/update | Manifesto pending/geração, efeitos idempotentes, ensaio de interrupção; repair antes de operação | E4-02/E5-03 |
| Backup inconsistente, disco insuficiente ou downgrade destrutivo | Backup pela camada owning, integridade/reabertura e restore isolado; nunca sobrescrever dados atuais silenciosamente | E5-01/03 |

Na revisão independente final, incluir explicitamente a fronteira de elevação, ACL/paths, ownership do mutex, ausência de bypass no pacote e os resultados incertos de persistência; a inspeção de UI não substitui essa revisão.

## 7. Rollback e matriz mínima de falhas

| Situação | Resposta esperada | Evidência necessária |
|---|---|---|
| Falha antes de intenção durável | Anterior confirmado continua; candidato descartado | Estado/hashes anteriores e ausência de efeitos publicados |
| Pending gravado; atalhos parcialmente aplicados | Startup operacional bloqueado; repair conclui ou compensa mesma intenção | Restart real, operationId/geração e inventário de links |
| Função confirmada; resposta perdida | Reler resultado; não repetir como nova troca | Mesmo ID retorna resultado consistente; outra geração não sobrescreve |
| Update falha antes de abrir dados com nova versão | Reparar binários aprovados mantendo dados e evidência | Instalação funcional e comparação dos perfis |
| Migração SQLite transacional falha | Rollback da transação; recusar startup se resultado não resolvido | SQLite real reaberto, schema/estado íntegros; sem publicação otimista |
| Nova versão já alterou schema/contrato | Recusar downgrade incompatível; reparar com versão compatível | Rejeição sem downgrade/recriação de banco; dados novos preservados |
| Banco/manifesto incompatível com versão antiga | Não abrir operacionalmente; não apagar config para forçar default | Preservação dos originais e diagnóstico |
| Restauração aprovada para backup anterior | Manter estado atual separado; restaurar conjunto validado, sem mesclar; explicar perda dos eventos posteriores | Ensaio em destino isolado e aprovação concreta antes de substituir dados reais |
| Mutex abandonado após crash | Adquirir com estado abandonado identificado; validar manifesto/recovery antes de operar | Crash real, sem segundo writer, sem autoplay nem exclusão de pending |
| Legado inacessível ou não cooperante em outra conta | Não declarar exclusividade; bloquear adoção e pedir resolução específica | Inventário/limite documentado; dados não alterados |

Backup de banco e rollback de instalação são contratos distintos. A [documentação SQLite](https://www.sqlite.org/backup.html) descreve snapshots consistentes e `VACUUM INTO`; o [WAL](https://www.sqlite.org/wal.html) exige preservar o estado que ainda não chegou ao arquivo principal. A decisão conservadora é evitar migração de schema nesta fase e nunca prometer que um instalador antigo entende dados novos.

## 8. Checklist do proprietário e inspeção dos artifacts

Executar após os checks automatizados viáveis, mantendo resultados individuais. A aprovação histórica D não vale como aprovação das novas superfícies E.

- [ ] Artifact baixado corresponde ao SHA/run/fingerprint registrado e ao SHA-256; versão e arquitetura conferidas; Authenticode relatado como observado, sem alegar assinatura inexistente.
- [ ] Inspeção independente do ASAR, assets, preloads, binding allowlisted e NSIS: um produto/exe, nenhum teste/perfil/banco privado/segredo; arquivos nativos somente os previstos.
- [ ] Instalar de fato o NSIS em VM/ambiente autorizado; observar UAC, diretório/escopo, atalhos e entrada de desinstalação. Marcar separadamente instalação silenciosa automatizada e interface interativa.
- [ ] Na primeira abertura do app, ver exatamente Reprodutor/Tudo em um e o segundo passo aprovado; teclado/foco/visual comparados ao Doop.
- [ ] Cancelar UAC/fechar setup e retomar; adiar biblioteca; abrir seletor nativo real de pasta/CSV e importar catálogo; não usar porta de teste como evidência do diálogo.
- [ ] Conferir nomes/ícones Desktop, Start Menu, janela e taskbar para ambas funções em cenários sequenciais; registrar pins antigos/limitações Explorer.
- [ ] Operar MP4 real (áudio audível e sincronismo percebido), fullscreen, fechamento normal e dados Gestão pertinentes, sem alegar implementação H8.
- [ ] Segunda conta real observa mesma função; tentativa de operar simultaneamente é recusada; conta comum não escreve configuração global; dados próprios permanecem isolados.
- [ ] Reexecutar instalador, cancelar e concluir troca; verificar app ativo em outra conta, preservação das duas bases e ausência de troca em Configurações.
- [ ] Atualizar/reinstalar/reiniciar o candidato: sem repetir função, sem atalhos incorretos, dados/ativação/recovery preservados; conferir recuperação interrompida em VM.
- [ ] Ler relatório independente e limitações residuais; aprovar explicitamente a Fase E ou registrar correções. Não iniciar F/G/H automaticamente.

## 9. Critérios objetivos para encerrar E

1. E0–E5 têm tickets com lotes executados, evidência e aprovações de etapa; estratégia E1 e alterações materiais efetivamente aprovadas.
2. Apenas `player`/`combined` são funções finais; Controller legado funciona como compatibilidade interna sem perda de domínio/dados ou segunda autoridade.
3. NSIS/exe únicos; seleção no primeiro app launch pelos frames aprovados; função global confirmada sobrevive a restart/update/reinstall; biblioteca adiável e CSV opcional.
4. Identidade/atalhos correspondem à função nas superfícies aprovadas/suportadas; limites taskbar/PE e pins documentados sem garantias falsas.
5. Exclusividade demonstrada entre contas/sessões/perfis Windows reais no escopo aprovado; falhas de ACL/gate bloqueiam; legado não cooperante tratado explicitamente.
6. Manutenção é o único caminho de troca; processo ativo, persistência incerta ou cancelamento não permitem alteração insegura; repair é testado e idempotente.
7. Upgrade/adoção/backup/restore preservam dados conforme matriz aprovada; schemas incompatíveis recusados; downgrade não é anunciado como rollback seguro; nenhum merge/reset implícito.
8. Testes proporcionais T0–T4 obrigatórios executados e PASS no candidato final; T5 e revisão independente concluídos, achados relevantes resolvidos e limitações aceitas explicitamente quando aplicável. Caso obrigatório NOT RUN mantém pendência.
9. Artifacts de PR e dispatch de validação rastreáveis/inspecionados, sem publicação; pipeline de release manual preservado; launcher oficial preservado e testado, sem duplicação por função.
10. Proprietário aprova encerramento E explicitamente; roadmap registra somente então a conclusão. F permanece dependente de autorização separada, sem antecipar suas campanhas de estabilização.

## 10. Prompt curto reutilizável para o executor

```text
Leia AGENTS.md, docs/standalone-player-roadmap.md, o ticket E correspondente e
docs/fase-e-plano-executivo.md. Execute somente o lote <ID> explicitamente autorizado
(ou a lista nominal autorizada), respeitando dependências/gates. Este plano sozinho
não autoriza execução. Revalide Git/código/consumidores; preserve alterações locais.
Implemente a menor mudança prevista e seus testes observáveis. Use SQLite/perfis
isolados, Electron real e runner Windows oficial conforme o lote; visual exige Doop
e comparação de screenshots. Não invente decisões de produto/aprovações, não migre
ou funda dados implicitamente, não enfraqueça testes. Registre PASS/FAIL/NOT RUN,
snapshot/artifact e limitações no ticket. Revise diff e documentação afetada.
Sem commit/push/publicação/dispatch ou instalação no ambiente real sem autorização
específica. Pare no gate ou no último lote autorizado; não inicie a próxima etapa.
```

## 11. Referências externas verificadas na elaboração

Fontes primárias complementam o código/lockfile; confirmar APIs na versão efetiva antes de implementar:

- [electron-builder NSIS v26](https://www.electron.build/v26/docs/nsis/): opções de escopo, atalhos e includes/hooks; preferir extensão mínima do NSIS existente.
- [Electron app](https://www.electronjs.org/docs/latest/api/app), [shell](https://www.electronjs.org/docs/latest/api/shell) e [ShortcutDetails](https://www.electronjs.org/docs/latest/api/structures/shortcut-details): identidade e atalhos. Suporte documentado não comprova comportamento do Explorer neste produto.
- [Microsoft: kernel object namespaces](https://learn.microsoft.com/en-us/windows/win32/termserv/kernel-object-namespaces): objetos globais entre sessões. Namespace global não resolve DACL, ownership ou lifecycle por si só.
- [SQLite backup](https://www.sqlite.org/backup.html), [WAL](https://www.sqlite.org/wal.html) e [riscos de corrupção](https://www.sqlite.org/howtocorrupt.html): backup/recuperação consistentes; não copiar apenas um banco vivo nem confundir downgrade com restauração.

## 12. Ledger da execução autorizada E1-03–E5-03

**Ledger histórico de 2026-11-08, anterior às revisões independentes.** Os resultados abaixo são preservados; o [parecer independente](fase-e-revisao-independente.md), a seção 14 e a atualização atual da seção 15 registram as evidências posteriores.

O proprietário autorizou o desenvolvimento integral de E1-03 a E5-03 em 2026-11-08. A tabela distingue implementação, evidência automatizada, validação ambiental e aceite. “Implementada” não significa lote tecnicamente aprovado. Resultados Windows anteriores valem somente para os fingerprints registrados no ticket E1; não foram reutilizados para mudanças posteriores do addon/runtime.

| Lote | Estado de desenvolvimento | Evidências desta execução e limites |
|---|---|---|
| E0-01–03 | **Concluídos e aprovados pelo proprietário** | Validação manual Windows PASS registrada no ticket E0; evidências técnicas anteriores preservadas. |
| E1-01/S1 | **Contrato aceito para desenvolvimento; S1 PARTIAL** | N-API básica foi demonstrada no spike; ACL/UAC/ramo administrativo/NSIS reais não viram PASS. Ver relatório S1 e contrato. |
| E1-02 | **Implementada; validação incompleta** | Testes unitários atuais PASS. Registros do fingerprint E1 anterior documentam runner Windows, build/verificador e carga N-API PASS naquele snapshot. Smoke Main empacotado, ACL/UAC e instalação NSIS permanecem NOT RUN. |
| E1-03 | **Implementada; validação incompleta** | Onboarding de duas etapas, função persistida, biblioteca e CSV opcional; testes unitários de setup/broker PASS. E2E Electron atual NOT RUN: Playwright encerrou antes de iniciar Electron (`Process failed to launch!` sob Xvfb). Comparação visual Electron/Doop NOT RUN. |
| E1-04 | **Implementada; build/homologação pendentes** | Configuração `perMachine:true`, página NSIS nativa de manutenção e teste estático de packaging/workflow PASS. Compilação NSIS, instalação real, UAC e cancelamento NOT RUN no snapshot atual. |
| E2-01 | **Implementada; evidência Windows/visual pendente** | Mapeamento de nome/título/AppUserModelID/assets por função; testes unitários e reprodução determinística dos ícones PASS. Explorer/taskbar no candidato e comparação de screenshot Electron NOT RUN. |
| E2-02 | **Implementada; integração nativa pendente** | Sincronização idempotente dos atalhos comuns, validação/readback e proteção de conflitos; unitários PASS. Smoke real de Shell/atalhos está registrado no runner, mas não foi executado para o snapshot atual. |
| E3-01 | **Implementada; comprovação do addon atual pendente** | Gate de processo e mutex Win32 global com DACL/lifecycle, mantendo o lock de foco por perfil; compile/unitários e testes estáticos do runner PASS. Compilar/carregar addon Windows atualizado e concorrência Electron empacotada NOT RUN no snapshot atual. |
| E3-02 | **Contrato/casos negativos preparados; comprovação real pendente** | Sem execução em duas contas ou sessões Windows. ACL cross-account, usuário sem escrita, conta não cooperante e competição com processo real permanecem NOT RUN. Não declarar exclusividade global PASS. |
| E4-01 | **Implementada; validação NSIS pendente** | Manifesto `pending`/commit de troca, locks administrativos/operacionais, sincronização e readback; teste unitário de falha/retentativa PASS. Fluxo nativo, instalação elevada e troca pelo candidato NSIS NOT RUN. |
| E4-02 | **Recovery lógico implementado; interrupção real pendente** | Repetição com mesmo `operationId`, bloqueio fail-closed e não sobrescrita do perfil cobertos por testes unitários. Kill/reboot entre efeitos NSIS/atalhos e recuperação após nova inicialização NOT RUN. |
| E5-01 | **Implementado para migrações SQLite cobertas; homologação Windows pendente** | `VACUUM INTO`, checksum/manifesto, integrity/FK check e restore somente para destino novo. Testes SQLite real, incluindo conteúdo commitado ainda em WAL, integridade, restore e tamper detection, PASS na suíte unitária. Não há backup atômico de múltiplos bancos/perfis. |
| E5-02 | **Política conservadora implementada; matriz de instalação pendente** | NSIS bloqueia instalação per-user detectada e registro global órfão/ambíguo; não move, converte, funde ou apaga perfis. Updates/reinstalações NSIS reais, versão N-1 identificada e isolamento de duas contas NOT RUN. |
| E5-03 | **Revisão técnica própria parcial; encerramento bloqueado** | Regressões unitárias completas, workflow/package tests e `git diff --check` PASS. Revisão independente separada NOT RUN; artifact do snapshot final não foi produzido/inspecionado; checklist manual e aprovação do proprietário pendentes. |

### Doop e discrepância de texto

Os frames `rKUlA0rV8m` e `gFR_COs4VP` foram relidos pelo Doop MCP e suas imagens foram abertas diretamente; ambos continuam `ready_for_dev`, aprovados pelo proprietário, em 1280×800. As descrições dos dois cartões de função e o conteúdo de acervo/catálogo correspondem ao `src/welcome.html`. O subtítulo/rodapé de `rKUlA0rV8m` promete que a função pode ser alterada em Configurações, mas A7 e a regra permanente aprovada reservam a troca à manutenção do instalador. A implementação e o teste mantêm A7; não foi adicionada troca em Configurações, nem alterado o frame. Essa divergência de copy exige correção/aceitação visual do proprietário antes de declarar E1/E2 homologadas. A tela de acervo permite configurar biblioteca/catálogo em Configurações; isso permanece compatível porque não troca a função. Nenhuma comparação de screenshot do Electron foi executada neste snapshot.

### Campanha e ambiente atuais

- `npm run test:unit` — **PASS** no ambiente Linux/WSL, incluindo compilação TypeScript, testes de regra/fila, Gestão, Player, SQLite, IPC, instalação, identidade, runtime gate, hooks e runner.
- Regressão adicional `node --test` — **PASS, 12/12**: broker e setup Welcome; contratos, runtime, sequência, interação, IPC, opções, adapter e recuperação Standalone/Player.
- `npm run test:release-workflow` — **PASS, 2 arquivos de teste**; inclui configuração de packaging e workflows. `node scripts/packaging-config.test.cjs` — **PASS, 6/6**; `node --check` do smoke de pacote/build script e `git diff --check` — **PASS**.
- `npm run test:e2e:operating-modes:headless` — **NOT RUN funcionalmente**: compilou, mas Playwright terminou `Process failed to launch!`; nenhuma assertion do app foi executada. Não se desativou o sandbox Chromium.
- Windows runner oficial no host atual — **NOT RUN**: chamada de PowerShell falhou antes do runner com `WSL (2 - ) ERROR: UtilBindVsockAnyPort:307: socket failed 1`. Não houve sync de checkout, build ou teste Windows neste snapshot. Não se reiniciou WSL/Windows e nenhuma política foi alterada.
- NSIS candidate, smoke Main empacotado, NSIS install/update/uninstall, ACL/UAC real e duas contas/sessões — **NOT RUN** no snapshot atual. A workflow não foi dispatchada. O checkout Windows anteriormente validado tem fingerprint próprio e não cobre as alterações posteriores; ver o ticket E1.
- Revisão independente de terceiro — **NOT RUN**. O fechamento desta execução não substitui a revisão read-only independente prevista em E5-03 nem a validação manual/aprovação do proprietário.

### Riscos e gates que permanecem

1. Não declarar S1, E1, E2, E3, E4, E5 ou Fase E concluída/aprovada enquanto houver as provas críticas indicadas como NOT RUN, falha aberta ou aceite pendente.
2. Nenhuma prova atual confirma UAC interativo/cancelamento/credenciais alternativas, ACL cross-account, duas sessões Windows, troca via NSIS nativo ou recovery após kill/reboot. Planejar esses casos em Windows hosted descartável quando não exigirem UI de UAC; para UAC e duas sessões usar Windows remoto/laboratório descartável existente. Não exigir VM local nem usar o host operacional.
3. Migração/rollback de pacote e adoção de instalações antigas seguem fail-closed. Backup de uma migração de schema não restaura automaticamente nem torna seguro instalar binário antigo; a API de restore cria somente um banco novo isolado.
4. Os ícones gerados são assets técnicos reproduzíveis; a identidade visual final ainda depende da referência aprovada pelo proprietário. A discrepância de texto do frame rKUlA0rV8m mantém aceite visual pendente.
5. A7 foi preservada. Qualquer mudança para oferecer troca de função em Configurações exigiria decisão de produto e referência visual atualizada; não foi inferida da copy inconsistente do frame.

## 13. Revisão independente inicial — 2026-11-08 (histórico)

Revisão independente executada, com especialistas read-only e revalidação nativa do fingerprint `745bcea049b6840578889ae716dd1d5f3510521a112ecf753349c20b6b274d48`. [Parecer, achados R1–R11, comandos e resultados](fase-e-revisao-independente.md).

Compile/unitários/SQLite locais e workflow tests PASS. A interop funciona fora do sandbox do processo WSL. O runner confirmou sync/compile Windows, mas falhou no harness de atalhos (cleanup antes da saída Electron). O addon atual compilou/carregou; a suíte de mutex falhou na primeira aquisição por `acl_error:1336`. Build candidato falhou na macro NSIS `NSD_CreateFirstRadioButton`; o verificador executado separadamente aceitou indevidamente o output intermediário. Não há candidato final válido ou artifact GitHub.

Também foram confirmadas corrida no bootstrap, ausência de coordenação segura do update NSIS/encerramento forçado herdado, lacuna de recovery inicial, atalhos sem remoção no uninstall, cobertura insuficiente do sentinel userData e adiamento de setup que repete seleção inválida. A recomendação NO-GO desta seção valia para aquele snapshot e foi reavaliada na seção 14. Testes protegidos/instalação/UAC/duas contas continuaram NOT RUN; S1 PARTIAL e nenhuma etapa E1–E5 foi aprovada. F não iniciada.

## 14. Correções da revisão independente — 2026-11-08

O proprietário autorizou corrigir R1–R10. O histórico da implementação, testes e limites está no [parecer atualizado](fase-e-revisao-independente.md); tickets E1–E5 têm evidências por etapa. Esta execução não alterou decisões A1–A7 nem declarou homologação.

| Achado | Resultado técnico | Gate que permanece |
|---|---|---|
| R1 NSIS inválido | Corrigidas macros de radio/manifesto e removida dependência NSIS não disponível; build NSIS e verify PASS. | Smoke de instalação/upgrade/uninstall NOT RUN. |
| R2 mutex 1336 | Comparação ACL normalizada; addon x64 e lifecycle real no Electron Windows PASS. | Duas contas, low-integrity e duas sessões NOT RUN. |
| R3 corrida de bootstrap | Gate obtido antes de ler/revalidar função; unitários e runner Windows PASS. | Cenário competitivo cross-account NOT RUN. |
| R4 update forçado | Sem término forçado; pending e locks admin→runtime fail-closed; NSIS compila. | Upgrade/maintenance real, flush/cancelamento e interrupção NOT RUN. |
| R5 recovery inicial | `repair-pending` retoma operação idempotente pelo mesmo `operationId`; testes unitários PASS. | Restart elevado/UAC real NOT RUN. |
| R6 atalhos uninstall | Remoção restrita a atalhos gerenciados identificados; testes unitários PASS. | NSIS uninstall real NOT RUN. |
| R7 cleanup harness | Aguarda término do Electron e limpa perfil; Windows runner PASS, sem processo residual. | Nenhum bloqueio ambiental para o harness atual. |
| R8 sentinel `userData` | Smoke consulta path do Main empacotado e compara SQLite/hash; testes de contrato PASS. | Smoke NSIS que instala em caminhos protegidos NOT RUN. |
| R9 CSV ao adiar | CSV inválido não é reenviado; Main/Renderer/SQLite Electron Windows PASS. | Sem pendência automatizável identificada. |
| R10 provenance | Selo de build só após sucesso; verify rejeita parcial/stale/divergente; testes negativos PASS. | Nenhum artifact hosted, pois PR/workflow não foi criado/dispatchado. |

### Evidências e snapshot

- Fingerprint oficial dos testes/build: **`03aa4d34e91f5aa8bc102d75d5668f29cffe849925f41715221310bb2cdae173`**; branch `feature/remote-player-lan-integration`, HEAD `10548d54e80825c6e6ddbdaf8f7038207bdabee3`. Após a validação, somente documentação/evidências foram alteradas; código, testes e workflows permaneceram iguais.
- WSL: `npm run compile`, `npm run test:unit`, `npm run test:release-workflow` e `git diff --check` PASS.
- Windows oficial: `PowerShell 5.1.26100.9711`, Node `24.11.0 x64`, npm `11.6.1`; compile, Electron/Playwright/SQLite isolados, shell shortcuts, mutex Win32, migrações, onboarding, Player, Combined, biblioteca/catalog e cleanup PASS; nenhum processo residual.
- Pacote: NSIS `Karaoke-Queue-Setup-0.5.0-x64.exe` construído e verificado sem instalar; SHA-256 `6ca793dce7fa8ea1cd6c71f948c025e6f88a9e990a7e31e453c61e300bf87b3b`; arquivo selado inclui commit e hash de conteúdo; addon de produção x64 carregado pelo Electron empacotado, `elevated:false`. A saída detalhada e checksum dos logs estão no parecer.
- Falhas dos dois builds candidatos intermediários anteriores foram preservadas nos checkouts NTFS e o verificador as rejeitou; nenhum desses outputs foi executado como instalador.

### Gates, recomendação e limites

**GO condicionado para um PR de validação após nova revisão independente read-only das correções.** O workflow existente deverá executar no Windows hosted o smoke empacotado e install/uninstall NSIS, criar artifact somente após sucesso, identificá-lo pelo SHA e não publicar Release. Nenhum PR/workflow foi criado ou disparado nesta execução.

S1 permanece **PARTIAL**. NSIS real, UAC interativo, ACL entre contas/low-integrity, duas contas/sessões, recuperação instalada, upgrade/reinstall/N-1/downgrade, Explorer/taskbar instalado e aceite visual/textual Doop permanecem NOT RUN/pendentes. E1–E5 seguem sem homologação/aprovação; E0 permanece aprovada e F não iniciada. A atualização documental depois dos testes não equivale a reexecutar a fingerprint do código; não foram alterados código/testes/workflows após `03aa4d34…`.

## 15. Validação após correções dos bloqueios finais — 2026-11-09

Esta seção atualiza apenas o snapshot descrito no parecer independente. Não promove E1–E5 a homologadas/aprovadas.

| Bloqueio | Implementação e teste | Status de validação |
|---|---|---|
| Pending de update com função nula | Recovery idempotente preserva `role:null`/`unconfigured`; testes de falha parcial, repetição e restart. | Unitários e regressões Windows Main/SQLite **PASS**; NSIS update/recovery real **NOT RUN**. |
| Janela de exclusividade no uninstall | Tombstone durável e locks admin→runtime durante toda a seção de remoção. GUI libera em `un.onGUIEnd`; NSIS silencioso não chama callbacks GUI e depende do fim da thread proprietária depois da seção, deixando o mutex abandonado para recuperação. O tombstone bloqueia startup até retry/reinstall reconciliar. Sem kill forçado. | Unitários e assertions estáticas **PASS**; uninstall concorrente/cancelamento/crash em NSIS **NOT RUN**. O caminho silencioso segue o contrato documentado de [callbacks NSIS](https://nsis.sourceforge.io/Docs/Chapter4.html?title=MessageBox) e [mutex Win32](https://learn.microsoft.com/en-us/windows/win32/sync/mutex-objects), ainda sem smoke NSIS real. |
| Smoke NSIS | Escopo PowerShell corrigido, DisplayName derivado de metadados efetivos, cleanup vinculado à installationId e ao executável exato. | Parser PowerShell nativo + testes release/workflow **PASS**; execução protegida hosted **NOT RUN**. |
| Proveniência | 218 inputs de build fingerprintados, incluindo preloads, copy-assets, scripts e testes; mudança invalida selo. | Testes negativos, selo e verificador do pacote atual **PASS**. |

Runner oficial Windows: branch `feature/remote-player-lan-integration`, HEAD `10548d54e80825c6e6ddbdaf8f7038207bdabee3`, snapshot fingerprint `3485486b7bffb7470863c124b792def0cdd5daa1d26c0775c94496cf18771d60`; regressões reais de Electron/Playwright/SQLite e o runner do candidato passaram. NSIS x64 e addon de produção x64 foram compilados/verificados; addon carregou em Electron 45 pelo modo Run-As-Node sem iniciar Main. Fingerprint de inputs selado: `3cb0090a142900f8dcd534bd41b51ef930d1e1e5f15bc6f9f86db97fe4bbfae4`; SHA-256 do instalador: `b8aef4fb40db719e554f849e3a07c72ec34cda59f4a59a22d09d67d709266885`. Smoke NSIS/Program Files/ProgramData, UAC, cross-account e duas sessões continuam **NOT RUN**. Após essa campanha, somente documentação/evidências foram alteradas; o código e os inputs de build não mudaram.

Recomendação: **GO condicionado para PR só de validação automatizada**, após revisão read-only das quatro correções. O workflow hosted deve executar os smokes protegidos e anexar artifact identificado por SHA; isto não aprova merge, homologação ou distribuição. Nenhum workflow/PR foi disparado/criado. S1 PARTIAL, E1–E5 sem aprovação e F não iniciada.

## 16. Coordenação estrutural F1–F3 — 2026-11-09

Implementação autorizada sem replanejar E: gate administrativo por árvore de processos (Job Object) mantém exclusão nos handoffs NSIS/helper; mutexes admin→runtime continuam protegendo efeitos/arquivos; fences obrigatórias são relidas antes da remoção. Release NSIS ocorre na worker proprietária, por seção final obrigatória após remoção/registro. Bootstrap inicial publica pending0 e só confirma unconfigured1 após sincronização dos links; role null preservada. Recovery de binário ausente exige pending protegido reconhecido. Nenhuma outra autoridade SQLite, serviço permanente, launcher ou decisão A1–A7 nova.

E1-02/04, E3-01/02, E4-01/02 e E5-01/02/03 receberam correções/testes proporcionais; E2 mantém o único writer de links bootstrap no helper. [Contrato, invariantes e 14 interleavings](fase-e-coordenacao-instalacao.md); [parecer e evidências](fase-e-revisao-independente.md#10-correção-estrutural-da-coordenação-f1f3--2026-11-09).

Unitários, workflow/proveniência, runner Windows oficial com Electron/SQLite, mutex/árvore Win32 e probes NSIS reais GUI/silencioso/crash/falha/fences: **PASS**. Snapshot final runner/build `3432e5d295cbffc241747061fd8704766b68d52f467a34da60dec28e654053fe`, HEAD `10548d54e80825c6e6ddbdaf8f7038207bdabee3`. Build NSIS x64/verificador/carga do addon final **PASS**. Inputs selados (223): `0b407cead36fb204ca2168f12a69a03bed81ab2e78ef92b0abaee0bfd530a423`; candidato SHA-256 `ae69327a4f5a0940fa8cae263478a04856b0124d4c3549fbcee6ac6d639bfd5f`. Atualização posterior somente documental não altera esses inputs.

Smoke corrigido usa cópia temp hash-verificada do uninstaller e userData padrão previamente inexistente da conta hosted (APPDATA sobrescrito não muda o known folder Electron). Verifica término/registro/pasta/links/perfil e prepara recusa de uninstall com Main vivo; execução instalada **NOT RUN**. CI inclui os novos probes sem instalar produto no host operacional; execução GitHub e artifact hosted **NOT RUN**.

**GO técnico condicionado somente para revisão final/PR de validação**; nenhuma autorização de commit/push nesta tarefa. Homologação continua bloqueada por NSIS instalado/upgrade/concorrência/crash/reboot, UAC, ACL/contas/integridades/sessões e checklist visual/humano. S1 PARTIAL, nenhuma E1–E5 aprovada, F não iniciada. O registro histórico de release GUI/abandono normal é substituído por este protocolo; abandono é falha/recuperação, não sucesso normal.


## Complemento autorizado: local, manutenção e onboarding — 2026-11-09

[Contrato dos ajustes e evidências](fase-e-ajustes-instalacao-onboarding.md). A autorização posterior permite escolher um local local protegido e redefine uninstall/reinstall para nova escolha de função. Substitui as premissas históricas de alvo fixo Program Files e retomada automática da função após reinstalação, preservando A1–A7, fences/locks, dados por conta e gates de homologação. Updates/reparos continuam preservando a função. Não equivale à homologação E1–E5.


### Evidência integral dos ajustes de instalação/onboarding

Run 42733046324, HEAD 896df22: Linux/Windows, NSIS gráfico/repair/uninstall/reinstall e artifact PASS; checksum baixado/verificado. [Matriz executada, fingerprint, artifact e NOT RUN](fase-e-ajustes-instalacao-onboarding.md#resultado-consolidado--ci-integral-pass). Os ajustes autorizados estão implementados e preparados para validação manual; não homologam E1–E5 nem iniciam F.
