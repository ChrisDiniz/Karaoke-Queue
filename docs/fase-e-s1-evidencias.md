# Spike S1 — evidências experimentais

Data: 2026-11-08. Escopo: spike descartável autorizado pelo proprietário para avaliar pré-requisitos técnicos da E1, sem integrar o protótipo ao produto. Não foram alterados código, banco, perfil, configuração, permissões, registro ou instalação operacional do Karaoke Queue. Nenhum commit, push, workflow, artifact de release ou instalação NSIS foi iniciado.

## Resultado geral

**Nota de replanejamento — 2026-11-08:** resultados abaixo preservados; S1 continua PARTIAL. A recomendação NO-GO absoluto ao desenvolvimento foi revista, a pedido do proprietário, no [contrato E1-01, seção 9](fase-e-e1-01-contrato-instalacao.md#9-gates-revistos-após-s1-partial). A proposta atual admite desenvolvimento isolado após aceite limitado/autorização nominal; mantém homologação, aprovação E1 e distribuição bloqueadas pelas provas críticas reais ausentes. As conclusões NO-GO abaixo registram a recomendação ao término do spike, não o novo gate de desenvolvimento.

**S1 parcialmente executado; não é PASS integral.** O binding mínimo compila como x64 contra os headers do Electron 45 e carrega no Electron 45.0.0 real, tanto sem pacote quanto em um pacote experimental manual com ASAR e `.node` externo. Os testes descartáveis demonstraram contenção entre processos da mesma conta, rejeição de DACL diferente, recuperação do mutex abandonado, bloqueio de reentrada e recusa de liberação por outra thread. A ausência ou corrupção do addon no pacote experimental falha fechada.

Não houve comprovação entre contas Windows, da etiqueta de integridade/SACL, de UAC ou ramo administrativo, de instalação/transição NSIS, nem de preservação da identidade e dados em upgrade. Esses itens permanecem **NOT RUN**, como casos obrigatórios do contrato S1. Não há incompatibilidade técnica observada nos casos executados; a infraestrutura e as restrições aprovadas impediram os casos restantes. A recomendação histórica ao encerrar S1 foi **NO-GO para E1-02** até completar a evidência e obter aceite. O gate atual proposto está na nota de replanejamento acima; esta conclusão histórica não bloqueia o desenvolvimento isolado nominalmente autorizado sob o novo contrato.

## Ambiente e isolamento

| Item | Evidência observada |
|---|---|
| Windows host | `DESKTOP-Q96P8CF`, Windows NT `10.0.26200.0`; PowerShell `5.1.26100.9711` |
| Toolchain inventariada | Node CLI `24.11.0`, Python `3.14.0`, Visual Studio Build Tools 2019 `16.11.36602.28`; `node-gyp` `12.4.0` |
| Runtime alvo | Electron `45.0.0`, Node embutido `24.22.0`, Node-API `10`, x64 |
| Projeto descartável | `E:\KaraokeQueue\spike-s1-20261108` (`/mnt/e/KaraokeQueue/spike-s1-20261108` via WSL), com perfis e resultados sintéticos sob essa raiz |
| Build | `node-gyp` recompilado para Electron 45 x64 com cache de headers isolado na pasta `header-cache` do spike |
| VM | **NOT RUN:** Hyper-V recusou enumeração por falta de permissão (`Get-VM`: exit 5). Foram encontrados metadados antigos de VirtualBox, mas não um runtime disponível; arquivos de VM não foram abertos nem alterados |
| GitHub-hosted Windows | **NOT RUN:** `.github/workflows/pr-validation.yml` só aceita `pull_request`; criar/atualizar PR não foi autorizado. `release-windows.yml` oferece `workflow_dispatch` de release e não foi acionado |

Não foram instalados NSIS ou ferramentas no host, nem usados Program Files, ProgramData, Registro, criação de contas, alteração de ACLs de arquivos reais ou elevação administrativa. Não foram usadas credenciais ou dados reais.

Na preparação inicial, `node-gyp` criou um cache de headers em `%LOCALAPPDATA%`; esse cache foi copiado e verificado dentro de `header-cache` no spike, e somente o diretório recém-criado por essa tentativa foi removido. A compilação final usou a cópia isolada. O Electron e as dependências do checkout manual existente foram lidos sem alteração.

## Matriz executada

| Experimento | Resultado | Observação e limite |
|---|---|---|
| Compilar binding N-API mínimo para Electron 45 x64 | **PASS** | `node-gyp@12.4.0` concluiu `rebuild` para `--runtime=electron --target=45.0.0 --arch=x64`. `s1mutex.node` é PE32+ x86-64. SHA-256: `fd41adde7198add2720b90a9da82e0f591ed726a714960c60e5ba2110d4c747a`. Build Tools 2019 funcionaram neste protótipo; não comprova a toolchain de todos os runners futuros. |
| Carregar e usar addon em Electron sem pacote | **PASS** | Electron 45.0.0, Node-API 10, `app.isPackaged=false`; aquisição, bloqueio de reentrada e liberação retornaram sucesso no perfil isolado `profile-evidence-unpackaged`. |
| Carregar e usar addon em Electron empacotado com ASAR | **PASS — pacote manual** | `app.isPackaged=true`; addon em `resources/native/s1mutex.node`, JS em `resources/app.asar`; aquisição, bloqueio de reentrada e liberação passaram no perfil `profile-evidence-packaged`. Isto não foi um build electron-builder nem instalador NSIS. SHA-256: ASAR `95ef07402a5876b17b4c6a4c8500f1afe708b72b58b064eafbfa048ed778d3d9`; executável experimental `KQ-S1.exe` `8e84549b05d27d444da2957653200d1e0ac287eff0fc5722b92835b9e0821a59`. |
| Mutex: concorrência, reentrada e DACL hostil pré-existente | **PASS — mesma conta** | Processo concorrente recebeu `busy`; aquisição recursiva recebeu `recursive_blocked`; objeto preexistente com DACL padrão diferente foi recusado como `acl_error`/`ERROR_INVALID_ACL` (1336); após liberação, outro processo adquiriu. Não prova acesso entre contas. |
| Mutex abandonado após encerramento abrupto | **PASS — mesma conta** | Processo filho adquiriu o mutex e foi encerrado; aquisição seguinte retornou `abandoned`, foi liberada e o handle neutro fechado. O teste é um protótipo e não simula recovery completo do aplicativo. |
| Liberação por thread diferente | **PASS** | Um Worker tentou liberar o handle adquirido pela thread principal e recebeu `wrong_thread`; a thread proprietária liberou com sucesso. |
| Addon ausente e arquivo `.node` inválido no pacote manual | **PASS — falha fechada do protótipo** | Ambos terminaram com exit code `5`, erro registrado e `ok=false`. O `.node` válido foi restaurado depois do ensaio. |
| ACL por SID entre duas contas e permissões de leitura/escrita efetivas | **NOT RUN** | O ensaio comparou a DACL do objeto experimental à DACL esperada sob a mesma conta. Não foram criadas contas nem testada a abertura do objeto por usuário padrão versus administrador. |
| SACL/mandatory integrity label e cruzamento de níveis de integridade | **NOT RUN** | A leitura experimental usou `DACL_SECURITY_INFORMATION`; não verificou a SACL/label efetiva nem o comportamento entre processos elevados e não elevados. |
| Dois mutexes em conjunto, ordenação admin → runtime, concorrência administrativa | **NOT RUN** | O protótipo expõe o segundo nome administrativo, mas a campanha não validou a combinação nem a estratégia de deadlock/ordem de locks em produto. |
| UAC, cancelamento, credencial de outro administrador, branch administrativo restrito | **NOT RUN** | Nenhum processo foi elevado e o protótipo não implementa o fluxo de instalação/manutenção aprovado. |
| NSIS assistido, instalação por máquina, transição de instalação per-user, upgrade e handoff | **NOT RUN** | Nenhum pacote electron-builder/NSIS foi construído ou instalado. Não houve alteração de appId/GUID, registro, Program Files ou dados. |
| Preservação real de identidade, manifesto global e dados por conta | **NOT RUN** | O pacote experimental não contém o manifesto ou bancos do produto; os perfis criados são apenas perfis Electron sintéticos. |

## Procedimento reproduzível

O transcript do host registra o comando executado e a sequência. O projeto-fonte, binding compilado, ASAR, executável experimental, JSONs de resultado e perfis sintéticos foram preservados na raiz descartável acima; nada foi copiado para o working tree do produto.

1. No Windows nativo, executar `node.exe <checkout>\node_modules\node-gyp\bin\node-gyp.js rebuild --directory=<spike> --runtime=electron --target=45.0.0 --dist-url=https://electronjs.org/headers --devdir=<spike>\header-cache --arch=x64`.
2. Executar em Node Windows os `test-node.js`, `test-abandoned.js` e `test-thread.js` na pasta do spike. Cada script encerra com erro se suas assertions falharem; o runner avança somente com exit code zero.
3. Montar manualmente `resources\app.asar` a partir de `app-src`, colocar o addon em `resources\native`, usar o executável Electron renomeado para `KQ-S1.exe` e iniciar com `--user-data-dir=<spike>\profile-evidence-<caso>`.
4. Repetir o Electron empacotado removendo e depois substituindo por bytes inválidos o addon, usando perfis separados; ambos devem sair com código 5 e relatar erro. Restaurar o binding compilado no `finally`.

Arquivos principais: `evidence/s1-host-transcript.txt`, `src/s1mutex.c`, os três scripts de teste e quatro JSONs de resultado. SHA-256:

```text
evidence/s1-host-transcript.txt  862739c8803ef21ebe3188b6de5164df414ccea628187cff082ec9e90e0d3b20
src/s1mutex.c                    481be9b8fd4db2e4f8a2b6939086b2996e8fba910392e3575d061b27aad51912
test-node.js                     e7f37706f48cbf06652702a261e6f0ae97ada3db7fa67255b62013df10609ade
test-abandoned.js                417143373b44ed58ae6c8b1b2ed409e2b741fbbb0bf0535b64d4a7428ebfe070
test-thread.js                   c06c891ff9ae48eae3a7df8fe0a2258f42ed78300ad72770bee6da16e2e6d08a
unpackaged-result.json           81fdfe10c870c22d8403919b6f07a7017acbd7d43154f31e5cd8bbeb8b863cf7
packaged-positive-result.json    7d26fb45cf998072fcce50005d6a7aa1cb3b1a3af6293eed5bbb0f236ac4f040
packaged-missing-result.json     81306817e66d65d6147b687ee793c23c279b7b1e345adc9450184541fa5f8caf
packaged-invalid-result.json     7da1bb7e1d127bf9860126c95f27c6c727161222f04635ba3111fc6cb127bab3
```

O arquivo `packaged-result.json` é sobrescrito pelo último caso negativo e deve ser interpretado junto dos JSONs nomeados e do transcript; não é sozinho o resultado positivo do pacote.

## Correções feitas no protótipo e limites

O primeiro comparador de DACL rejeitava também a ACL criada pelo próprio Windows porque a representação textual foi canonicalizada. O protótipo foi corrigido para comparar a máscara explícita efetiva; depois, a ACL padrão preexistente continuou sendo rejeitada. Na primeira tentativa de abrir o pacote experimental, o executável chamava-se `electron.exe`, fazendo Electron selecionar o app padrão; o executável foi renomeado para `KQ-S1.exe` e o ensaio empacotado passou. São correções do protótipo/procedimento, não alterações no aplicativo de produção.

O teste de ASAR cobre o comportamento de `app.isPackaged` e a carga do `.node` externo numa distribuição Electron montada manualmente. Não comprova electron-builder, o `asarUnpack` do produto, assinatura, SmartScreen, instalação real, registro, atalhos, AppUserModelID, atualização ou rollback. Os testes do mutex não comprovam DACL por duas contas, privilégio, manutenção, flush do SQLite ou exclusão global efetiva em E3.

## Decisão e próximos gates

### Efeito sobre as decisões aprovadas A1–A7

| Decisão | O que S1 comprova | O que segue pendente |
|---|---|---|
| A1 — instalação por máquina/UAC | Nada sobre instalação ou elevação. | UAC, cancelamento, token administrativo, instalação per-machine e transição legada. |
| A2 — função global/dados por conta | Nada sobre manifesto/ProgramData ou separação de dados entre contas. | ACL global, duas contas/sessões, persistência e comprovação de `userData`/SQLite por usuário. |
| A3 — mutex Win32/N-API | Viabilidade básica do binding e cenários de mutex na mesma conta/integridade. | ACL entre contas/integridades, SACL/label, lock administrativo, ordem dos locks e integração no produto/electron-builder. |
| A4 — identidade por função | Nada sobre identidade ou atalhos. | `appId`, AppUserModelID, ícones, atalhos e superfícies reais Windows no pacote instalado. |
| A5 — adoção legada conservadora | Nada sobre descoberta/adoção de instalações legadas. | Matriz de instalações existentes, conflito entre contas, bloqueio seguro e preservação dos perfis reais/fixtures NSIS. |
| A6 — backup/recuperação/downgrade | Nada sobre SQLite ou atualização. | Backup consistente, restore isolado, falhas parciais e recusa de downgrade incompatível. |
| A7 — manutenção nativa NSIS | Nada sobre o wizard ou seus textos/erros. | Reparar/trocar função/cancelar/retomar em NSIS real e validação dos textos/fluxos. |

- A evidência confirma viabilidade básica de compilar e carregar um binding Node-API x64 com Electron 45, e confirma alguns comportamentos de mutex sob a mesma conta e integridade do host.
- Não foi encontrado bloqueio técnico no recorte ensaiado. Permanecem bloqueadas a confirmação de A1/A2/A4/A5/A6/A7 em ambiente real de instalação, e a validação completa de A3 entre contas/integridades.
- **Registro ao término do spike (antes do replanejamento): S1 integral PENDENTE; E1-01 técnico PENDENTE; recomendação E1-02 NO-GO e não iniciado.** O spike parcial não autoriza substituir os cenários ausentes nem deslocá-los silenciosamente para lotes posteriores.
- Para completar a matriz, usar VM Windows descartável com snapshot, duas contas reais e sessão interativa para UAC, ou ambiente hospedado descartável somente quando houver um mecanismo de execução autorizado e sem acionar release/publicação. Repetir o handoff per-user → machine com fixtures sintéticas e registrar ACL/SACL efetivas, logs, códigos de saída, identidade e hashes antes/depois.
- No encerramento original do spike, recomendou-se completar todos os casos antes de autorizar E1-02. O replanejamento da seção 9 do contrato passa a distinguir aceite limitado de desenvolvimento e homologação final. A autorização S1 não inicia E1-02; as provas reais seguem obrigatórias para homologação.

## Evidência suplementar de integração — 2026-11-08

Após a revisão independente, o binding de produção foi compilado pelo toolchain Windows e carregado pelo Electron empacotado do candidato Fase E (`Electron 45.0.0`, Node `24.22.0`, x64). O runner Windows oficial também passou o harness do mutex no Electron real: aquisição, contenção, ownership por thread, release, abandono e readback da ACL. Fingerprint testado: `03aa4d34e91f5aa8bc102d75d5668f29cffe849925f41715221310bb2cdae173`.

Este resultado acrescenta evidência à viabilidade básica de A3 no código atual, mas não altera o status do spike original: S1 continua **PARTIAL**. O harness usa nome isolado e uma conta; não comprova ACL entre contas, low-integrity, duas sessões, instalação NSIS, transição legada, UAC ou o ramo administrativo instalado. Não confundir o candidato build/verify PASS com instalação ou homologação.
