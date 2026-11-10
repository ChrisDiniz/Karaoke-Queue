# 0005/0000 — E0: Consolidação Controller → Combined

## Identificação

- Ticket: 0005/0000
- Ticket pai: 0005 — Fase E: Consolidação de funções, instalador e gerenciamento
- Etapa canônica: E0
- Status: Concluído — E0 aprovada explicitamente pelo proprietário em 2026-11-08
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Consolidar os caminhos de produto Controller e Combined em uma única função final `combined`, preservando integralmente a Gestão existente e sua autoridade operacional única no Main, estabelecida na D4.3. Ao final da E0, as funções finais de produto serão somente `player` e `combined`.

## Escopo

- Auditar os caminhos atuais `controller` e `combined` antes de qualquer alteração de código, identificando diferenças reais de startup, composição, IPC, janelas, serviços, permissões e persistência.
- Eliminar Controller como função independente selecionável do produto; não remover seu domínio operacional nem tratá-lo como código descartável.
- Preservar mesas, cantores, sessões, histórico, fila, prioridades, Round Robin, regras de conclusão/cancelamento e SQLite.
- Preservar a única autoridade operacional da Gestão no Main; não criar uma segunda aplicação, fila, writer ou caminho concorrente de persistência.
- Manter compatibilidade segura com configurações e instalações legadas `controller`, somente na medida tecnicamente necessária; essa compatibilidade não representa uma terceira função selecionável.
- Não apagar, converter, fundir ou migrar dados automaticamente sem estratégia validada e aprovação aplicável. Registrar como configurações legadas serão lidas e preservadas.
- Adaptar testes, contratos, documentação e launchers existentes conforme consumidores reais identificados pela auditoria.
- Preservar integralmente a operação Standalone (`player`) e seus contratos, sequência e dados.
- Executar regressões automatizadas e validação Windows nativa apropriadas, sem declarar resultados antes da execução.

## Fora de escopo

- Instalador NSIS, onboarding de escolha `player`/`combined`, identidade Windows, exclusividade entre contas e manutenção do instalador: E1–E4, sujeitos aos gates próprios.
- HTTPS/WSS, pairing, autenticação de dispositivos, sincronização e autoridade remota: Fase G.
- Integração de reprodução local à Gestão Combined: H8.
- Alteração das regras de negócio, V1, dados operacionais ou UI sem requisito aprovado.

## Dependências e gates

- Fases C e D concluídas e aprovadas; a D4.3 estabelece o host Main-side e o writer operacional único que devem ser preservados.
- Autorização explícita do proprietário para iniciar a implementação da E0.
- Auditoria comparativa dos caminhos Controller e Combined antes de escolher a estratégia de consolidação.
- E1 somente começa após conclusão e aprovação explícita da E0.

## Atividades planejadas

1. Mapear entry points, modos/capacidades, startup, janela e preload, handlers IPC, licenciamento, serviços, banco, lock e shutdown em ambos os caminhos.
2. Comparar comportamento e contratos, identificando diferenças necessárias, compatibilidade legada e consumidores que dependem de `controller`.
3. Propor e implementar a menor consolidação segura que deixe `combined` como única função de Gestão, sem antecipar E1.
4. Adaptar testes e launchers para não apresentarem Controller como terceira função final, mantendo cobertura de compatibilidade legada necessária.
5. Rodar regressões focadas e completas aplicáveis, incluindo Electron real, persistência isolada e runner Windows nativo oficial.
6. Revisar dados, ownership, authority, shutdown e referências documentais antes de solicitar aprovação de encerramento.

## Critérios de conclusão

- O inventário demonstra as diferenças reais entre os caminhos `controller` e `combined` e documenta as decisões de compatibilidade.
- Apenas `player` e `combined` permanecem como funções finais selecionáveis; qualquer suporte `controller` restante é interno e justificado.
- Mesas, cantores, sessões, histórico, fila, Round Robin, prioridades, persistência e recuperação permanecem operacionais sob `combined`.
- A Gestão continua com uma única `KaraokeApplication`/autoridade Main-side e um único writer operacional; não há coexistência concorrente de produção.
- Configurações legadas `controller` são tratadas sem perda ou conversão automática de dados não aprovada.
- Standalone continua independente da fila operacional e sem regressões.
- Suítes pertinentes e validação Windows nativa executadas, resultados e limitações documentados; critérios funcionais só recebem PASS com evidência.
- A documentação confirma que E1 depende da aprovação da E0 e que H1 não repetirá sua consolidação de função.

## Validação prevista

Usar testes unitários de capacidades/configuração e compatibilidade; integração Main/IPC com Electron real; regressões da Gestão para sessões, fila, prioridades, Round Robin, SQLite, recuperação e shutdown; regressões do Player; perfis/bancos isolados; launcher manual oficial e runner Windows nativo conforme cobertura necessária. Distinguir testes de harness, integração e produção real. Nenhum resultado foi executado ou aprovado nesta etapa documental.

## Decisões preservadas

- Uma única função final de Gestão: `combined`; `controller` não é terceira opção de produto.
- Preservar o domínio Controller e sua implementação operacional necessária à Gestão.
- Preservar a autoridade Main-side e o corte single-writer realizados na D4.3.
- Não antecipar instalação, onboarding, identidade, exclusividade, rede ou reprodução local H8.
- A mudança de escopo transfere para E0 a remoção de Controller como função independente, anteriormente atribuída ao planejamento de H1; H1 permanece responsável pela Gestão no contexto de integração operacional remota.

## Aprovação final — 2026-11-08

O proprietário concluiu a validação manual da E0 no Windows nativo: **PASS, nenhum problema encontrado**, e aprovou explicitamente a E0. E0-01, E0-02 e E0-03 estão concluídos e a pendência de revisão/aceitação das superfícies entregues está encerrada. As evidências abaixo são preservadas como registro da campanha anterior ao aceite; suas menções a aprovação pendente descrevem aquele momento. Não atribuir a esse aceite resultados individuais de cenários não executados. Naquele registro de transição, o proprietário havia autorizado somente E1-01; essa autorização limitada foi substituída por autorizações posteriores documentadas nos tickets e no ledger executivo.

## Progresso e evidências de execução — 2026-11-08

### E0-01 — PASS

- `controller` e a ausência de configuração são lidos como entrada legada e resolvidos em memória para `combined`; a leitura não regrava `operating-mode.json` nem cria arquivo quando ele está ausente.
- Gravações novas aceitam apenas `player` e `combined`. Parser estrito, preservação de configuração inválida e prevenção de onboarding sobre perfil existente permanecem cobertos.
- `npm run compile`: PASS. `node build/tests/operating-mode.test.js`: 9/9 PASS. `node build/tests/persistence.test.js`: 29/29 PASS. `node build/tests/main-media-runtime.test.js`: 4/4 PASS.
- `node build/tests/operating-modes-electron.js` sob Xvfb: PASS com Electron real, Playwright e perfis/SQLite temporários. Cobriu Controller explícito sem regravação, fallback sem arquivo, escolha inicial e reinicialização de Player/Combined, sessão/fila SQLite após restart e configuração inválida preservada.

### E0-02 — PASS técnico; aceite final registrado abaixo

- Welcome apresenta somente Reprodutor e Tudo em um, seguindo o frame `rKUlA0rV8m` em 1280×800. A configuração inicial salva a função e o restart abre o modo escolhido.
- A seção de troca de função das Configurações foi removida conforme A7; as rotas Main/Preload/IPC de troca normal foram removidas. Não foi adicionado novo conteúdo ou layout às Configurações.
- Configuração de biblioteca inválida em Combined agora emite `VIDEO_LIBRARY_CONFIGURATION_INVALID`, mantém o arquivo intacto e permite que a Gestão e SQLite iniciem com biblioteca vazia. Em Player, a configuração inválida continua bloqueando o startup.
- PASS focados: `main-window-factories` 3/3; `main-player-ipc` 4/4; `main-controller-ipc` 4/4; `video-library.test` 16/16; `video-library-electron.js` 4 cenários; `music-catalog-electron.js` 3 cenários. Também passou novamente a suíte `operating-modes-electron.js`.
- Os frames de Welcome (`rKUlA0rV8m`) e biblioteca/catálogo (`gFR_COs4VP`) estão `ready_for_dev`; não foi alterado Doop. Não há frame Doop aprovado para Configurações. A captura Electron foi inspecionada para verificar a remoção sem criar uma tela substituta, mas a aceitação visual final pertence ao proprietário.

### E0-03 — PASS técnico; aprovação final registrada abaixo

- `npm run compile`, `npm run test:unit` e `npm run test:release-workflow`: PASS. Os unitários Standalone `test:unit:standalone-runtime` (35), `test:unit:standalone-sequence` (73), `test:unit:standalone-ipc` (35) e `test:unit:standalone-options` (5) também passaram.
- Electron real Linux/Xvfb com perfis/SQLite temporários: PASS em `multi-instance`, `operating-modes`, `persistence`, `ipc-validation`, `management-legacy-import`, `round-robin`, `debut-cadence`, `previous-sessions`, `session-close`, `drag`, `video-library` (4 cenários), `music-catalog` (3 cenários), `standalone-player-production` com MP4 real e `player-playback-recovery` com MP4 real. `management-legacy-import` passou após a fixture criar diretamente JSON Controller legado, em vez de usar o escritor que agora aceita apenas funções finais.
- Regressão Windows nativa oficial — `npm run test:e2e:multi-instance:windows -- --approve-untracked`: PASS no fingerprint `0cb00f62bfe6787775b53d354457299a78ae4df2f9ecf383edba6ccc2a74113d`, branch `feature/remote-player-lan-integration`, HEAD `10548d54e80825c6e6ddbdaf8f7038207bdabee3`. Node 24.11, npm 11.6.1, Electron/Playwright Windows, perfis e SQLite temporários. Migração, modos legado/novos, biblioteca, catálogo e Main de produção passaram; minimizar/restaurar e foco passaram; cleanup sem processos residuais.
- Regressão Windows nativa oficial — `npm run test:e2e:standalone-production:windows -- --approve-untracked`: PASS no mesmo fingerprint, Main/Preload/IPC Standalone de produção, MP4 real read-only, SQLite/perfil isolados, playback, recovery, shutdown e cleanup. A asserção de foco passou com clique OS Win32 `SendInput` e evento confiável no Renderer. O relatório do runner para este modo indica `WINDOW_FOCUS NOT APPLICABLE`; a suíte multi-instância confirmou foco nativo separadamente.
- T3: `npm.cmd run build:windows`, `npm.cmd run verify:windows-build` e `node tests/packaged-windows-smoke.cjs "dist\win-unpacked\Karaoke Queue.exe"`: PASS. Installer NSIS local `Karaoke-Queue-Setup-0.5.0-x64.exe`; ASAR com 97 arquivos e `node:sqlite`, sem addon SQLite nativo. Smoke `app.isPackaged=true`, trial inicializado, escrita/leitura Renderer→Preload→IPC→SQLite e persistência após restart. SHA-256 do installer `7495D527EE797850C1D155B9FAB2C0FAB08E4B4ADC170E8FBCE65414A3B35301`; Authenticode `NotSigned`, sem signatário. O pacote não foi instalado, publicado nem anexado a Release. `npm ci` no Windows reportou 6 advisories moderados existentes; nenhuma dependência foi alterada.
- Uma primeira execução Windows falhou numa expectativa de viewport que confundia a moldura nativa com o viewport do Renderer; a validação passou a fixar o Renderer de produção em 1280×800 via Playwright, dimensão usada pelo frame Doop. O smoke de foco Player também revelou que clique CDP não ativa HWND; foi substituído por clique Win32 nativo com verificação de foco, sem enfraquecer a asserção. A execução interrompida pela reinicialização deixou um lock sem PID ativo e sem sync/build backup pendente; o clone foi preservado, sem remover o lock, e a campanha final passou em um clone NTFS novo.
- Nenhum cenário obrigatório T0/T1/T2/T3 ficou NOT RUN. T4 (instalação NSIS interativa) é fora do escopo E0 e não foi executado; T5/manual do proprietário não está concluído. A captura Welcome Electron foi comparada ao frame aprovado `rKUlA0rV8m` em 1280×800. Não existe frame Doop aprovado para Configurações; a remoção do seletor foi inspecionada, mas a aceitação visual final do proprietário permanece pendente.
- Naquele snapshot, E0 estava tecnicamente pronta para revisão, mas ainda não havia aprovação. O estado foi superado pela validação manual Windows PASS e aprovação explícita do proprietário registradas a seguir.

## Aprovação final do proprietário — 2026-11-08

O proprietário validou manualmente a E0 no Windows nativo: **PASS, nenhum problema encontrado**, e aprovou explicitamente a etapa. E0-01, E0-02 e E0-03 estão concluídos e E0 está encerrada. As evidências automatizadas e seus limites históricos permanecem preservados acima; a aprovação não converte cenários individuais não executados em PASS. Posteriormente, o proprietário autorizou o desenvolvimento sequencial E1-03→E5-03, incluindo correções e validações pendentes de E1-02; essa autorização não aprova nenhuma etapa E1–E5.

## Riscos

- Diferenças não inventariadas entre os caminhos podem alterar startup, licenciamento, IPC ou dados de perfis existentes.
- Um alias legado pode ser confundido com uma terceira função ou criar uma segunda autoridade se aplicado fora do Main.
- Testes que assumam somente um modo podem perder cobertura de compatibilidade; testes que mantenham Controller como opção de produto podem mascarar a consolidação incompleta.
- Mudanças de schema, localização de dados, exclusividade por computador e instalação pertencem aos gates E1–E3; não devem ser improvisadas nesta etapa.

## Histórico

Nova etapa aprovada para anteceder E1. O planejamento anterior deixava a retirada de Controller como função final para H1; o proprietário transferiu essa consolidação para E0, antes do instalador, preservando em H1 as atividades próprias da integração operacional remota. A Fase D segue concluída e aprovada. Na criação do ticket, E0 estava planejada e não iniciada; a autorização explícita para E0-01→E0-03 foi registrada em 2026-11-08, com status atual no topo e evidências acima.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Ticket E1 — Instalador único e abertura inicial](0001-e1-instalador-unico-selecao-funcao.md)
- [Ticket H1 — Gestão Combined preparada para operação remota](../0008-fase-h-integracao-operacional-gestao-player/0001-h1-gestao-operacional.md)
- [D4 — Auditoria e arquitetura Main](../../d4-main-remote-architecture-preparation.md)
- [Remote Player architecture](../../remote-player-architecture.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
- [Windows native testing](../../windows-native-testing.md)
