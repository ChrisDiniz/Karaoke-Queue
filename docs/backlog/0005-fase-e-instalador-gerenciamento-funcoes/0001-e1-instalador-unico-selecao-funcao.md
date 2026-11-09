# 0005/0001 — E1: Instalador único e seleção no primeiro uso

## Identificação

- Ticket: 0005/0001
- Ticket pai: 0005 — Fase E: Consolidação de funções, instalador e gerenciamento
- Etapa canônica: E1
- Status: Em revisão — coordenação estrutural, runner Windows e NSIS x64 build/verify PASS; instalação/UAC/homologação pendentes
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Auditar, aprovar e implementar um único instalador Windows Electron Builder/NSIS e um único executável de produção. A função não é escolhida durante a instalação NSIS: na primeira abertura do aplicativo, o onboarding apresenta Reprodutor (`player`) ou Tudo em um (`combined`) no frame aprovado `rKUlA0rV8m`, seguido pelo frame `gFR_COs4VP` para configurar a biblioteca de vídeos e o catálogo CSV opcional. `controller` é somente compatibilidade transitória e não é opção futura.

## Escopo

- Reutilizar Electron Builder/NSIS existente quando adequado.
- Manter um instalador Windows e um executável; não criar instaladores ou launchers de produção separados por função.
- No primeiro uso, apresentar a escolha Reprodutor/Tudo em um, seguida da configuração da biblioteca e do catálogo CSV opcional. A biblioteca pode ser configurada depois em Opções.
- Persistir a função em local definido pela estratégia E1; reinicializações e updates não repetem seleção nem recriam onboarding já concluído.
- Não oferecer troca de função em Configurações; mudanças posteriores pertencem à manutenção do instalador.
- Antes de mudanças relevantes de instalação, permissões, exclusividade ou migração, verificar e detalhar a estratégia sob A1–A7 aprovadas, submetendo o detalhamento técnico ao gate E1-01: instalação por máquina, múltiplas contas, persistência/localização da função, instalações/modos legados, `userData`, bancos, biblioteca, catálogo, locks, recovery, atualização e manutenção.
- Definir como a escolha e a configuração inicial lidam com falhas parciais; não criar instalação, writer ou autoridade paralela, nem marcar onboarding concluído antes do estado necessário estar confirmado.
- Avaliar permissões para configuração compartilhada e atalhos globais; não exigir privilégios administrativos silenciosamente. Especificar consistência da escolha entre contas conforme o escopo aprovado, sem tratar `userData` por usuário como exclusividade do computador.
- Mapear upgrade, reinstalação, mudança de função, rollback, preservação de dados e recuperação de falha parcial sem presumir conversão de bancos ou fusão de perfis.
- Preservar SQLite, sessões, histórico, biblioteca, catálogo, preferências, recovery e dados de qualquer função anterior.
- Uma função instalada/ativa por computador é a regra de produto; E3 implementa e valida sua garantia técnica no escopo aprovado. E1 não declara a exclusividade técnica concluída.
- Auditar `.github/workflows/` antes de propor CI novo; preferir reutilizar build Windows/NSIS e artifact de PR existente. Artifact de validação deve identificar commit/fingerprint e não publicar Release, fazer deploy/push ou usar credenciais reais de assinatura.

## Dependências

- Fases C e D concluídas e aprovadas.
- [E0 — Consolidação Controller → Combined](0000-e0-consolidacao-controller-combined.md) concluída e aprovada; o alvo E1 parte das duas funções finais `player` e `combined`.
- Autorização explícita do proprietário para iniciar E1.
- A1–A7 já aprovadas; aceite E1-01 limitado ao desenvolvimento isolado e autorização nominal antes de E1-02. Homologação final exige provas reais críticas e aceite da etapa; a aprovação arquitetural não substitui nenhum desses gates.

## Critérios de conclusão

- Auditoria/estratégia cobrem instalação por usuário/máquina, privilégios, contas Windows, locks, função persistida, modos legados, localização/proteção de dados, upgrades, reinstalação, mudança de função, rollback e falha parcial.
- Decisões A1–A7 respeitadas; aceite limitado do detalhamento antes do desenvolvimento E1-02 e comprovação crítica real antes da homologação/aceite E1. A aprovação arquitetural não autoriza execução por consequência.
- Há um instalador e um executável; NSIS não pergunta a função. A primeira abertura apresenta somente Reprodutor e Tudo em um nos frames aprovados, iniciando na função escolhida.
- A função fica persistida e restart/update não repetem a escolha; a biblioteca pode ser configurada depois.
- O fluxo oferece configurar biblioteca de vídeos e catálogo CSV opcional; a configuração da biblioteca permanece disponível posteriormente.
- Configurações não trocam a função; mudanças posteriores usam manutenção do instalador.
- Falhas parciais preservam dados e não criam instalação/autoridade paralela; permissões globais e entre contas seguem estratégia aprovada.
- Instalações existentes e dados recebem o tratamento aprovado, sem conversão/fusão presumida.
- Componentes compartilhados necessários permanecem no pacote.
- E1 não se apresenta como validação da garantia de exclusividade entre contas Windows; a implementação e comprovação pertencem a E3.

## Validação prevista

Auditar workflows e a estratégia; após aprovação explícita, construir/instalar em Windows nativo e usar o launcher manual oficial para testar os dois caminhos de primeiro uso com perfis isolados escolhendo a função dentro do onboarding real. Cobrir função persistida em restart/update, catálogo opcional, biblioteca adiada/configurada depois, dados preservados e falhas de seleção/configuração. Não usar dois launchers de produção nem um override que enfraqueça a exclusividade; testes entre contas e garantia pertencem a E3.

## Decisões preservadas

- Um único instalador, duas opções de função.
- Uma função por computador é a regra aprovada de produto; garantia técnica tem etapa própria E3.
- Não trocar a função pelas Configurações; a escolha inicial em onboarding segue os frames aprovados.
- Updates e mudanças de função devem preservar dados; não presumir conversão de bancos ou fusão de perfis.

## Aprovações arquiteturais e gate técnico — 2026-11-07

O proprietário aprovou A1–A7 no [plano executivo, seção 3.5](../../fase-e-plano-executivo.md#35-decisões-a1a7-aprovadas-pelo-proprietário--2026-11-07). A1 estabelece instalação única por máquina, com UAC explícito na instalação, manutenção e confirmação inicial da função; operação normal sem elevação. A2 estabelece função global e dados operacionais (`userData`, SQLite, históricos, sessões, bibliotecas e configurações) separados por conta Windows, sem compartilhamento/fusão automática de bancos. A3 aprova mutex Win32 global, preferencialmente binding N-API mínimo, condicionado à comprovação real no Windows/Electron empacotado; inviabilidade exige alternativa para nova aprovação.

A4 preserva executável genérico, appId e paths de dados, com identidade por função e ativos finais sujeitos à referência aprovada. A5 determina adoção legada conservadora, sem mover, converter, fundir ou excluir automaticamente; conflitos não resolvidos bloqueiam operações potencialmente inseguras. A6 exige backups SQLite consistentes, recuperação segura e bloqueio de downgrade incompatível; restauração que possa descartar dados posteriores requer autorização específica. A7 prioriza interface nativa NSIS para manutenção, alteração de função e erros; textos e fluxo final continuam sujeitos à validação.

**Gate original (2026-11-07; substituído para desenvolvimento pela proposta pós-S1 abaixo):** E1-01 verifica viabilidade, implementação concreta, permissões/ACL, persistência global versus dados por conta, NSIS, N-API e recuperação, documenta evidências e requer aceite do detalhamento técnico antes de liberar E1-02. A aprovação arquitetural não comprova esses itens nem a exclusividade implementada, cuja validação pertence a E3. E0 foi concluída e aprovada pelo proprietário em 2026-11-08 após validação manual Windows PASS. Naquele snapshot, E1-02 e demais lotes E1–E5 não haviam começado e permaneciam sujeitos a gates/autorização. Este registro não acrescenta aceite visual; as autorizações posteriores e o estado atual estão nas seções abaixo.

## E1-01 — Parecer entregue em 2026-11-08

Autorização explícita do proprietário: encerrar E0 aprovada e executar integralmente somente a auditoria E1-01; em seguida, autorização específica para S1 com adaptação de ambiente. Contrato, evidências, matriz A1–A7, riscos, testes futuros e ajustes por lote estão em [E1-01 — contrato de instalação](../../fase-e-e1-01-contrato-instalacao.md), e os resultados do spike em [evidências S1](../../fase-e-s1-evidencias.md).

- E0: validação manual Windows PASS, nenhum problema encontrado; concluída e aprovada nesta data.
- Inspeção documental/estática executada: package/lock, templates efetivos builder 26.18.0, bootstrap/IPC, SQLite, verificador/smoke, launcher/runner e workflows. GUID derivado: `7792ee38-9a49-5e2e-a032-ba1be2d8f3a5`; appId preservado.
- Inventário Windows e spike: PowerShell 5.1.26100.9711, Windows 10.0.26200.0, Node CLI 24.11.0, Python 3.14.0, Build Tools 2019 16.11.36602.28, node-gyp 12.4.0; Electron 45.0.0 embute Node 24.22.0/N-API 10. O binding N-API x64 compilou e carregou no Electron sem pacote e em pacote experimental manual com ASAR. Mutex da mesma conta passou reentrada, concorrência, abandono, thread e rejeição de DACL divergente; addon ausente/inválido falhou fechado.
- **S1 parcial; não é PASS integral.** Duas contas/sessões, DACL entre usuários, SACL/label, UAC/cancelamento/outra credencial, ramo administrativo, mutex admin combinado e NSIS per-machine/transição/upgrade ficaram **NOT RUN**. Hyper-V não permitiu enumerar VMs (exit 5) e não havia runtime VirtualBox. O workflow de PR não aceita dispatch; o workflow de release com dispatch não foi acionado. Nenhuma instalação NSIS ou alteração de Program Files/ProgramData/Registro/contas/permissões reais. Ver [evidências S1](../../fase-e-s1-evidencias.md) para comandos, resultados e hashes.
- A1–A7: estratégia sem incompatibilidade observada no recorte, mas comprovação completa pendente para as decisões abrangidas pelos casos NOT RUN; nenhuma decisão aprovada foi substituída.
- Ajuste necessário: antecipar binding mínimo para serialização administrativa em E1-02; E3 reutiliza-o para exclusão operacional. Não usar generation/operationId como substituto de lock. Contrato de handoff mantém pending durável entre processos, sem transferir ownership do mutex.
- **Recomendação histórica ao encerrar S1, substituída pela proposta abaixo — NO-GO E1-02:** S1 integral ainda pendente e aceite do detalhamento técnico não obtido. O recorte não apontou incompatibilidade N-API, mas os casos obrigatórios NOT RUN mantêm o gate fechado. A autorização S1 não inicia E1-02; E1-01 não foi aceita como gate técnico nem E1 concluída.
- Nenhum código de produção/teste/script/workflow foi alterado. O protótipo, pacote Electron manual e perfis ficaram somente em `E:\KaraokeQueue\spike-s1-20261108`; sem instalação NSIS, dispatch, artifact de release, commit, tag ou push. Evidências E0 preservadas.
- Validação documental: 121 caminhos locais conferidos nos seis documentos E1/plano/roadmap/índice afetados, nenhum ausente; `git diff --check` sem erros e nenhuma linha com trailing whitespace nos documentos atualizados. Doze links absolutos históricos para capturas `/tmp` do roadmap continuam indisponíveis e preservados sem alegar nova inspeção das imagens. Os hashes/procedimentos S1 estão no relatório vinculado. Não há PASS inferido de documentação para casos NOT RUN.

## Replanejamento pós-S1 — proposta de 2026-11-08

O proprietário autorizou revisar a documentação para propor GO condicionado ao desenvolvimento isolado. **Não autorizou implementar nesta tarefa.** A seção 9 do [contrato E1-01](../../fase-e-e1-01-contrato-instalacao.md#9-gates-revistos-após-s1-partial) passa a governar os gates: aceitar o detalhamento apenas para desenvolvimento e autorizar nominalmente E1-02 permite implementar com testes isolados, mesmo com S1 PARTIAL. A homologação E1, aprovação da etapa e distribuição continuam bloqueadas por qualquer caso crítico NOT RUN/FAIL.

E1-03/04 podem seguir com autorizações próprias após testes de desenvolvimento dos predecessores PASS, mantendo status “desenvolvimento validado; homologação pendente”. E2 e posteriores conservam aceites/dependências existentes; não há liberação em bloco. O texto exato de autorização limitada e o prompt para o executor estão na seção 10 do contrato. Windows local do proprietário continua restrito a testes não destrutivos sem elevação e dados sintéticos; NSIS/contas/ACLs reais somente em Windows descartável remoto/hospedado apropriado, com execução autorizada. Nenhuma VM local é exigida.

### Ledger inicial de comprovação pendente

Este é o ledger inicial, registrado antes da execução autorizada E1-02; seus estados são a baseline histórica e não incorporam a recuperação posterior abaixo. Resultados atuais, hashes e lacunas ficam na seção “Recuperação das validações E1-02 — 2026-11-08”.

| Obrigação | Ambiente e lote responsável | Estado atual / evidência |
|---|---|---|
| Binding no candidato electron-builder, ASAR/recursos/PE e módulo ausente/inválido | E1-02 build/inspeção; E1-04 pacote e smoke completo em fixture hospedada protegida | Protótipo manual PASS no relatório S1; produto **NOT RUN** |
| Manifesto protegido, ACL/owner/reparse, SACL/label e duas contas/tokens | E1-02 implementa/testa regras isoladas; E1-04 homologa em Windows descartável | Mesma conta/DACL divergente PASS no protótipo; matriz real **NOT RUN** |
| Ramo administrativo sem bootstrap/perfil admin, geração, ACK perdido e falhas de publicação | E1-02 T0/Electron isolado; E1-04 homologa ramo elevado real | Produto **NOT RUN** |
| UAC aceito/negado/outra credencial, quoting/Unicode e relaunch sem elevação | E1-02/03 desenvolvem contratos; E1-04 homologa em desktop interativo remoto/laboratório | **NOT RUN**; hosted sem interação não substitui prompt real |
| NSIS limpo/per-user→machine, GUID/appId/HKCU/HKLM, cancelamento/recovery e dados por conta preservados | E1-04: automático no hosted se suportado + casos interativos em Windows externo descartável | **NOT RUN**; instalação proibida no host operacional |
| Onboarding real, duas escolhas, biblioteca/CSV, restart por etapa/conta e visuais Doop | E1-03 T0/T1/T2 viáveis; segunda conta/UAC em E1-04 | Fluxo E1 novo **NOT RUN**; evidências E0 são históricas |
| Exclusividade operacional em duas sessões, ordem admin→runtime, handoff/flush/crash | E3-01/02, após aceites e autorizações próprios | Mutex parcial S1 não certifica produto; **NOT RUN** |
| Manutenção completa/adoção/backup/restore/rollback e artifacts antigos reais | E4/E5, conforme matriz/autorizações próprias | **NOT RUN**; nenhum restore destrutivo autorizado |

**Validação desta revisão (snapshot da proposta, anterior ao aceite):** sete documentos revisados; 125 caminhos locais e sete âncoras conferidos, sem erro; nenhum trailing whitespace e `git diff --check` sem erros. Os 12 links absolutos históricos para capturas `/tmp` permanecem indisponíveis, preservados como histórico. Nenhum teste de aplicação ou infraestrutura foi executado por aquela revisão documental. O estado “E1-02 não iniciado” descreve apenas aquele snapshot e foi substituído pela execução autorizada registrada abaixo.

## Histórico

### E1-02 — implementação e evidências parciais (2026-11-08)

O proprietário aceitou o contrato E1-01 para desenvolvimento isolado e autorizou somente E1-02. Nenhuma decisão A1–A7 foi alterada. A implementação permanece **aguardando validação técnica**, não está marcada como E1-02 PASS nem E1 concluída.

- O `main.ts` agora funciona como bootstrap mínimo: o ramo administrativo reconhece somente `confirm-initial`, antes de importar `main-runtime.ts`; não solicita lock de instância, registra protocolo, abre `userData`, logger, licença, SQLite ou Renderer. O processo empacotado valida a instalação global e injeta a função confirmada no Main antes de carregar sincronamente a composição operacional, preservando registro de protocolo e lock de instância antes de `app.ready`.
- `src/installation-control.ts` implementa manifesto v1 estrito em `%ProgramData%\KaraokeQueue\installation.json`, publicação atômica, geração, `pending`, `operationId`, leitura de confirmação e bloqueio de corrupção/estado pendente. O app normal só lê a autoridade global. Dados, SQLite, sessão, biblioteca, catálogo, licença e recovery permanecem sob `userData` da conta Windows. O modo `controller` legado continua sendo lido somente no fluxo não empacotado; configuração local antiga não substitui a função global no pacote.
- O ramo administrativo exige contexto Windows empacotado, token elevado, imagem no caminho Program Files, diretório/manifesto confiáveis e mutex administrativo Win32; confirma apenas a função inicial. Revalida ACL/owner do manifesto depois de cada replace atômico e mantém `pending` ou estado confirmado, sem avanço, se a verificação falhar. Não existe troca de função, comando genérico, alteração por Configurações, broker UAC/NSIS ou gate de exclusividade operacional nesta entrega. Pending/estado irrecuperável bloqueia startup.
- O addon C usa Node-API v8 e é gerado por `beforePack` contra a versão Electron do lockfile; somente o recurso `resources/native/win32-x64/kq_win32.node` é permitido fora do ASAR. O appId `com.karaoke.queue`, um executável, as opções NSIS atuais e `perMachine:false` permanecem inalterados; não houve build/instalação do NSIS.
- O smoke do pacote foi adaptado para uma fixture Windows descartável sob Program Files e ProgramData, com função global sintética e perfil SQLite isolado. Ele não instala NSIS, cria contas, executa UAC ou comprova ACL entre usuários; requer runner efêmero capaz de criar e limpar esses diretórios. Nenhum workflow foi editado ou disparado.

**Validação executada:** `npm run compile` PASS; `npm run test:unit:installation-control` PASS; `npm run test:unit` PASS, incluindo regressões unitárias, SQLite, Gestão, Player, IPC e as novas suítes de controle/bootstrap/admin; `npm run test:release-workflow` PASS; `node scripts/packaging-config.test.cjs` PASS (4/4); `node scripts/installation-binding-build.test.cjs` PASS (3/3); `node --check tests/packaged-windows-smoke.cjs` PASS; `git diff --check` PASS.

**NOT RUN:** `npm run test:e2e:operating-modes:headless` compilou, mas Playwright não iniciou Electron (`Process failed to launch`; diagnóstico direto anterior: `sandbox_host_linux.cc:41 / Operation not permitted`), então o cenário Electron não foi executado. O runner Windows oficial interrompeu o preflight antes de sincronizar checkout/build/Electron com `UtilBindVsockAnyPort:307: socket failed 1`. Portanto compilação/carga do addon de produção, fixture empacotada, `verify-windows-build`, ACL/owner/reparse/SACL efetivos, token/ramo admin real, UAC, duas contas, NSIS/handoff e recovery Windows permanecem NOT RUN. Não houve instalação, elevação, escrita em ProgramData/Program Files/Registro/ACL reais do proprietário, nem abertura de dado operacional.

O S1 continua **PARTIAL**: o protótipo anterior não é a implementação deste lote. A homologação e aprovação E1 continuam bloqueadas. E1-03 **não está tecnicamente liberada** porque os critérios de desenvolvimento que exigem Electron real e prova nativa segura do candidato não passaram; também faltam sua autorização nominal e consulta atual aos frames Doop. Não iniciar lotes posteriores por inferência.

#### Evidências reproduzíveis

- `npm run test:unit:installation-control`
- `npm run test:release-workflow`
- `npm run test:unit`
- `env -u WAYLAND_DISPLAY xvfb-run -a node build/tests/operating-modes-electron.js` — NOT RUN pelo bloqueio de sandbox acima.
- `npm run test:e2e:multi-instance:windows -- --approve-untracked` — NOT RUN pelo bloqueio de interop acima; não houve sync/build/teste Windows.
- `npm run build:windows` / `npm run verify:windows-build` — NOT RUN; requer toolchain/headers Windows e pacote candidato; não foi instalado NSIS.

Na validação inicial descrita acima, nenhum artifact foi publicado nem transferido ao checkout NTFS; os resultados da recuperação posterior estão registrados a seguir.

### Recuperação das validações E1-02 — 2026-11-08

O proprietário autorizou corrigir o ambiente de teste e repetir as validações pendentes, sem avançar para E1-03. O checkout usado foi exclusivamente `E:\KaraokeQueue\e1-02-validation\checkout` (NTFS), criado a partir do snapshot WSL pelo runner oficial. Nenhuma instalação, elevação, escrita em ProgramData/Program Files, ACL, Registro, conta ou configuração operacional foi feita no computador.

- **Interop/runner — PASS:** `powershell.exe`/`cmd.exe` falham com `UtilBindVsockAnyPort:307: socket failed 1` quando chamados pelo processo sandboxed do Codex; a mesma chamada mínima do PowerShell funciona pela execução aprovada fora desse sandbox. O runner oficial então sincronizou e verificou o checkout e concluiu `WINDOWS REPORT PASS`, sem alterar `.wslconfig`, `wsl.conf` ou política global. Snapshot `feature/remote-player-lan-integration`, HEAD `10548d54e80825c6e6ddbdaf8f7038207bdabee3`, fingerprint `c7770ae9259abf2cf5157a70899da55965579916d2929a177547b2f1d728a6e7`.
- **Regressão focada — FAIL inicial corrigido; PASS final:** a primeira execução Windows marcou 14 PASS, 1 FAIL e 1 SKIP: o teste injetava falha no segundo `fsync` esperando flush de diretório, que a implementação intencionalmente não tenta no Windows. A produção não foi alterada. O teste passou a injetar erro de resultado incerto depois do `renameSync` real; a suíte `npm run test:unit:installation-control` passou no Windows com 15 PASS, 0 FAIL, 1 SKIP por criação de symlink indisponível, além de 3/3 testes do hook de build. A mesma suíte também passou no WSL; `npm run test:release-workflow` passou 2/2.
- **Runner Windows / Electron, Playwright e SQLite — PASS:** compilação nativa e suítes de migração SQLite (10), operating-mode (9), video-library (16) e music-catalog (25); E2E real de multi-instância, modos, biblioteca e catálogo; foco/minimize/restore; limpeza sem processo residual. Perfis e bancos foram temporários e isolados.
- **Build NSIS candidato — PASS, sem instalar:** `npm run build:windows` exit 0; node-gyp 12.4.0 compilou o addon x64 usando Python 3.14.0, Visual Studio 2019 Build Tools 16.11.36602.28, MSBuild/Windows SDK e headers Electron 45.0.0. `npm run verify:windows-build` exit 0: um instalador x64, ASAR com 103 entradas, ícone válido e exatamente um addon PE x64 fora do ASAR. NSIS mantém `perMachine:false`; build não significa instalação homologada.
- **Carga N-API no Electron Windows — PASS limitado:** loader `loadWindowsInstallationBinding()` real carregou o addon `resources/native/win32-x64/kq_win32.node` associado ao candidato e o módulo JavaScript dentro do `app.asar`, no Electron 45.0.0 / Node 24.22.0 / N-API 10. As chamadas somente leitura retornaram `elevated:false` e `executableInProgramFiles:false`; perfil temporário isolado. Isso comprova compilação/carga do binding e API exportada, mas não executa o Main empacotado nem confirma o ramo administrativo.
- **Smoke do executável empacotado — NOT RUN:** `tests/packaged-windows-smoke.cjs` copia para Program Files, cria `%ProgramData%\KaraokeQueue`, aplica ACL e inicializa manifesto. Rodá-lo no host violaria os limites desta autorização. `WindowsSandbox.exe` não está presente; Hyper-V/VM não está disponível e nenhuma feature foi habilitada. Portanto não se usou um desvio por caminho alternativo nem se declarou smoke PASS.
- **Electron/Xvfb Linux — NOT RUN:** Electron falha antes de abrir com `sandbox_host_linux.cc:41 ... Operation not permitted`; o processo do ambiente registra `NoNewPrivs=1` e `Seccomp=2`. A hipótese mais provável é bloqueio do sandbox externo/seccomp na criação do sandbox Chromium, não defeito confirmado do produto. O sandbox Chromium não foi desabilitado.
- `npm ci` no clone registrou 6 vulnerabilidades moderadas no audit de dependências; nenhuma correção automática foi aplicada. S1 continua **PARTIAL**: ACL entre contas/integridades, SACL/label, UAC/cancelamento/outra credencial, admin branch elevado, NSIS install/transição/upgrade, duas sessões e recuperação real seguem **NOT RUN**.

**Artifacts e logs locais (não publicados):** `E:\KaraokeQueue\e1-02-validation\checkout\dist\Karaoke-Queue-Setup-0.5.0-x64.exe` SHA-256 `AC4F6580CFB826BF429360D894C43EBB64D627633C4804EE3E35BCBC2EF6C13D`; `dist\win-unpacked\resources\app.asar` SHA-256 `352B2ADBAFEBAF0CDF9E08D89E65530E42CD693308F6E8FABA4307F5509243FE`; addon candidato SHA-256 `F73DAB88F2CD19B1CD761F5B31F6882BB4A012D890D87A1707A2CCEFFFC1346D`. Harness não versionado `addon-smoke\load-addon.cjs` SHA-256 `4B3D612020CD43E296C1BF6720FB3E34CA846974DA4C31A7C4CAA9BA46B261BB`; stdout do Electron `addon-smoke\stdout.log` SHA-256 `A2056DAA99C915FACCCF5FF1F81417E2E3F34E60F7D22B2B8FA249605811BFFC`; stderr vazio. O harness pode ser repetido com `KQ_E1_SMOKE_USER_DATA=E:\KaraokeQueue\e1-02-validation\addon-smoke\user-data`, `KQ_E1_SMOKE_ASAR=E:\KaraokeQueue\e1-02-validation\checkout\dist\win-unpacked\resources\app.asar`, `KQ_E1_SMOKE_RESOURCES=E:\KaraokeQueue\e1-02-validation\checkout\dist\win-unpacked\resources` e `node_modules\electron\dist\electron.exe addon-smoke\load-addon.cjs`. Logs focados de build/verificação/teste estão sob `E:\KaraokeQueue\e1-02-validation\` (`build-windows.log`, `verify-windows-build.log`, `focused-unit.log`).

**Estado técnico atualizado:** o core de E1-02 tem validações automatizadas focadas e regressões Windows reais PASS, e build/verificação/carga N-API do candidato PASS. O teste completo do executável empacotado é obrigatório e permanece NOT RUN; portanto E1-02 segue em validação, não está PASS/concluída, e E1-03 não está tecnicamente liberada nem foi autorizada. E1 homologação/aprovação, S1 integral e distribuição permanecem bloqueadas.

Derivado da antiga D1 (auditoria e estratégia, preservada como preflight desta etapa) e da antiga D2 (instalador e seleção). Os frames Welcome aprovados posteriormente definiram a seleção inicial no onboarding, substituindo a proposta anterior de selecionar exclusivamente no instalador; a exclusividade foi separada para E3. Ao fim do S1, antes da autorização atual, a implementação não havia iniciado.

## Atualização após autorização integral de desenvolvimento — 2026-11-08

O proprietário autorizou E1-03 e E1-04 como parte do desenvolvimento sequencial E1-03→E5-03, incluindo correções/validações de E1-02. Essa autorização substitui os registros anteriores de “E1-03 não autorizada”; não remove gates de segurança, homologação, aprovação E1 ou distribuição. A1–A7 e S1 PARTIAL permanecem inalterados.

- **E1-03 — implementação presente:** `src/welcome-setup.ts`, Welcome em duas etapas (`player`/`combined`, biblioteca e CSV opcional), persistência da escolha/setup e broker de confirmação inicial. `npm run test:unit` e as regressões adicionais `installation-role-broker`/`welcome-setup` passaram. Os cartões de função e a configuração da biblioteca/catálogo correspondem às imagens Doop. O texto do frame `rKUlA0rV8m` que promete mudança em Configurações contradiz A7; o código mantém troca somente via manutenção NSIS. Essa divergência impede aceite visual final; o frame não foi alterado.
- **E1-03 — NOT RUN:** `npm run test:e2e:operating-modes:headless` compilou, mas Electron/Playwright não iniciou (`Process failed to launch!`), portanto nenhuma assertion de UI, restart real ou screenshot do app foi executada. UAC real/cancelamento e onboarding pelo executável empacotado também não foram repetidos no snapshot atual.
- **E1-04 — implementação presente:** `package.json` fixa NSIS per-machine; `build-resources/installer.nsh` cria manifesto protegido, bloqueia instalação per-user/estado ambíguo e fornece a página nativa de manutenção para troca posterior; os workflows existentes fazem build/verificação, smoke empacotado e smoke install/uninstall em Windows hosted descartável, com artifact distinto para PR e `workflow_dispatch` de validação, sem publisher. `node scripts/packaging-config.test.cjs`: PASS 6/6; `npm run test:release-workflow`: PASS (2 arquivos de teste). A macro NSIS `TrimNewLines` foi corrigida para passar o texto antes da variável de saída e tem asserção estática.
- **E1-04 — NOT RUN:** não foi feita compilação NSIS, instalação/upgrade/uninstall, manutenção interativa, UAC ou dispatch no snapshot atual. O fingerprint anterior `c7770ae9259abf2cf5157a70899da55965579916d2929a177547b2f1d728a6e7` comprova somente o candidato daquele estado E1-02; não cobre mudanças subsequentes em C, E2–E5.
- **Ambiente/regressão atual:** `npm run test:unit` PASS; regressão adicional de broker/setup/Standalone/recuperação PASS 12/12; `node --check` do smoke/build script e `git diff --check` PASS. A chamada PowerShell pelo WSL falha antes do runner com `UtilBindVsockAnyPort:307: socket failed 1`; não houve execução Windows atual. Não se desativou Chromium sandbox. Nenhum app operacional, ProgramaData/ProgramFiles, Registro, ACL, conta, workflow ou artifact foi alterado/criado.
- **Estado:** E1-02/03/04 têm implementação e evidência local, mas não PASS integral. Smoke do pacote, NSIS, UAC/ACL cross-account e validação visual Electron continuam NOT RUN. S1 permanece PARTIAL; homologação/aprovação E1 e distribuição bloqueadas.

## Revisão independente inicial — 2026-11-08 (histórico)

R1/R2/R3/R5/R7/R9/R10: build NSIS e aquisição do mutex falharam no Windows atual; há corrida no bootstrap e lacuna na retomada da confirmação inicial. Unitários/compile passaram, sem PASS integral. O fingerprint atual, evidências, recomendações e limites estão no [parecer independente](../../fase-e-revisao-independente.md). **NO-GO para PR de validação até correções; nenhuma aprovação da etapa.** Os registros anteriores de implementação/NOT RUN são históricos, sem promover testes omitidos a PASS.

## Correções da revisão independente — 2026-11-08

Esta atualização substitui o status de falha técnica do parecer anterior, sem marcar E1 concluída/aprovada.

- **R1/R4 — build NSIS PASS:** macros de radio, parsing do manifesto e hook de execução foram corrigidos; removida a dependência `nsProcess`, ausente na toolchain efetiva. A coordenação de update usa pending durável e locks, sem término forçado. Build/verificador PASS no candidato SHA-256 `6ca793dce7fa8ea1cd6c71f948c025e6f88a9e990a7e31e453c61e300bf87b3b`.
- **R5 — recovery inicial:** a operação pending é retomada por `repair-pending` com o mesmo `operationId` e readback; testes em `installation-admin`/`installation-control` incluídos em `npm run test:unit` PASS. Restart elevado/UAC real permanece NOT RUN.
- **R7/R8 — harness/smoke:** cleanup de perfil aguarda saída do Electron; smoke de userData consulta o caminho do Main empacotado e compara sentinel SQLite/hash. Testes estáticos PASS e runner Windows final PASS. A instalação/desinstalação NSIS necessária para executar o smoke de userData permanece NOT RUN.
- **R9 — setup adiado:** “Configurar depois” não reenvia o CSV inválido e preserva biblioteca confirmada; E2E Electron/SQLite Windows PASS.
- **Validação:** `npm run compile`, `npm run test:unit`, `npm run test:release-workflow`, runner Windows oficial, build NSIS e `verify:windows-build` PASS no snapshot de fingerprint `03aa4d34e91f5aa8bc102d75d5668f29cffe849925f41715221310bb2cdae173`. Addon x64 real carregado no Electron empacotado. O workflow GitHub e o artifact hosted não foram executados.
- **Gates:** S1 permanece PARTIAL. UAC interativo, ACL entre contas/low-integrity, duas sessões, instalação/upgrade/uninstall reais, smoke protegido e aceite visual/textual Doop permanecem NOT RUN/pendentes. Ver [parecer atualizado](../../fase-e-revisao-independente.md).

## Correções dos bloqueios finais da revisão E — 2026-11-09 (histórico; protocolo substituído abaixo)

O código mantém `role:null`/`unconfigured` quando update/repair começa antes da seleção inicial. `prepare-update` preserva a intenção pendente e o mesmo `operationId`; `repairPendingInstallation` conclui no estado não configurado, sem escolher `player` ou `combined`. Testes cobrem falha parcial, retry, restart lógico e idempotência. `npm run test:unit` e o runner Windows do fingerprint `3485486b7bffb7470863c124b792def0cdd5daa1d26c0775c94496cf18771d60` passaram.

O uninstall NSIS agora adquire o tombstone durável pelo helper, então readquire os mutexes globais admin→runtime e os retém durante toda a seção de remoção. No modo GUI, `un.onGUIEnd` os libera explicitamente; no modo silencioso, o NSIS não chama callbacks GUI e a thread proprietária termina após a seção, deixando o mutex abandonado conforme Win32. O tombstone bloqueia startup até retry/reinstall adquirir os gates e reconciliar o estado. Falha de aquisição bloqueia a remoção; retry/reinstall preserva função e dados SQLite/userData. As regressões unitárias e assertions de ordem passaram. O teste real de uninstall concorrente, cancelamento, crash e retry NSIS permanece **NOT RUN**. Ver os contratos oficiais de [callbacks NSIS](https://nsis.sourceforge.io/Docs/Chapter4.html?title=MessageBox) e [mutex Win32](https://learn.microsoft.com/en-us/windows/win32/sync/mutex-objects).

O primeiro build NSIS deste ciclo foi **FAIL** por `warning 6001`: variáveis do uninstaller existiam também na compilação do installer. O include agora limita essas variáveis/hooks a `BUILD_UNINSTALLER`; o build subsequente e `verify:windows-build` passaram. A saída parcial da primeira tentativa foi preservada em `E:\KaraokeQueue\failed-nsis-20261109-r1`, não instalada/executada.

O smoke PowerShell tinha código PowerShell dentro do here-string entregue a `node.exe -e`. A função de `DisplayName` foi movida para o escopo PowerShell e usa os metadados efetivos do Electron Builder/versão, sem valor de produto hardcoded para a exibição. O cleanup de Program Files requer correspondência da `installationId`; atalhos só são removidos se apontam ao executável exato. Parser PowerShell nativo e `npm run test:release-workflow` passaram. Smoke de instalação real continua **NOT RUN** porque só pode escrever em Program Files/ProgramData no runner GitHub-hosted descartável; nenhum workflow foi disparado.

`windows-build-provenance.cjs` cobre 218 arquivos de build, incluindo preloads Player, `scripts/copy-assets.ts`, recursos NSIS/N-API, scripts e testes; os testes alteram inputs representativos e comprovam rejeição do selo antigo. O candidato NSIS `Karaoke-Queue-Setup-0.5.0-x64.exe` foi compilado x64, verificado e carregou o addon pelo Electron 45 em modo Run-As-Node sem iniciar Main. Fingerprint de inputs selado: `3cb0090a142900f8dcd534bd41b51ef930d1e1e5f15bc6f9f86db97fe4bbfae4`; SHA-256: `b8aef4fb40db719e554f849e3a07c72ec34cda59f4a59a22d09d67d709266885`. O artifact está somente em `E:\KaraokeQueue\e-independent-windows-final-20261108\checkout\dist`; não foi enviado ao GitHub.

**Status E1:** desenvolvimento e build candidatos passaram nos checks executados; smoke Main instalado, NSIS upgrade/uninstall, UAC, ACL cross-account e recovery instalado após interrupção continuam NOT RUN. S1 permanece PARTIAL; E1 não está homologada/aprovada. Após a campanha, somente documentação/evidências foram atualizadas.

## Coordenação estrutural F1–F3 — 2026-11-09

Bootstrap inicial usa pending/prepare-update generation0 e confirma unconfigured1 só depois de arquivos/registro/links verificados. Confirmação UAC inclui installationId; NSIS exige fences e árvore herdada; estado pendente reconhecido permite recópia sem helper antigo. Role null preservada, nenhum perfil convertido. Parser do smoke PASS; pressuposto APPDATA substituído pelo known folder real da conta hosted, com recusa de perfil preexistente.

**Evidência atual:** unitários/workflow/proveniência e runner Windows oficial Electron/Playwright/SQLite PASS no snapshot `3432e5d295cbffc241747061fd8704766b68d52f467a34da60dec28e654053fe`. Binding real, árvore de processos e probes NSIS GUI/silencioso/crash/falha/fences PASS em fixtures isoladas. Build NSIS x64/verificador/carga do addon final PASS; inputs `0b407cead36fb204ca2168f12a69a03bed81ab2e78ef92b0abaee0bfd530a423`, candidato SHA-256 `ae69327a4f5a0940fa8cae263478a04856b0124d4c3549fbcee6ac6d639bfd5f`. Atualização posterior somente documental.

[Contrato e matriz de interleavings](../../fase-e-coordenacao-instalacao.md); [parecer, status por achado e logs reproduzíveis](../../fase-e-revisao-independente.md#10-correção-estrutural-da-coordenação-f1f3--2026-11-09). Este registro substitui as descrições históricas de release GUI/abandono normal e o NO-GO anterior, sem apagar evidências.

**Gate:** GO técnico condicionado para revisão final/PR somente de validação. Não houve commit/push/PR/dispatch nem instalação no host. Instalação/update/uninstall/reinstall/crash reais, ACL elevada/cross-account, UAC, duas contas/sessões e validação humana continuam NOT RUN/pendentes. S1 PARTIAL, nenhuma E1–E5 homologada/aprovada; F não iniciada.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Ticket E3 — Exclusividade por computador](0003-e3-exclusividade-por-computador.md)
- [Windows release process](../../windows-release-process.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
- [Windows native testing](../../windows-native-testing.md)


### Correção do bootstrap administrativo durante CI — 2026-11-09

Aguardar ready no helper modificava ShaderCache/index do perfil operacional, reproduzido no Main real em comando administrativo recusado. Dispatcher agora síncrono antes de ready; sem nova autoridade/executável, preservando fences, token, ACL e mutexes. Shell .lnk pré-ready e preservação de todos os arquivos (perfil aquecido/novo) passaram em Windows real, fingerprint `9eedc1950675625bad917dfa4bd7550a64282198a67228750e42e4bdc70e98ae`. Contêiner vazio criado nativamente antes do JS é baseline explicitamente testado, sem dados operacionais. [Parecer, seção 23](../../fase-e-revisao-independente.md#23-helper-administrativo-sem-inicialização-do-perfil-chromium--2026-11-09). Nova homologação CI NSIS pendente; não aprova E1.
