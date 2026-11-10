# Fase E — Coordenação administrativa Windows

Contrato de desenvolvimento após F1–F3. A1–A7 permanecem aprovadas; S1 PARTIAL e E1–E5 sem homologação. Este documento descreve os mecanismos implementados, não certifica cenários NOT RUN. O [parecer](fase-e-revisao-independente.md) e os tickets registram as evidências por snapshot.

## Recursos e ordem

1. **Job Object global de operação**, `Global\com.karaoke.queue.install-operation.v1`: associação de árvore de processos, com owner Administrators e DACL protegida somente SYSTEM/Administrators. Installer/uninstaller entram antes de ler/mutar o manifesto. Um objeto existente só admite um processo que já pertença à árvore; uma segunda árvore falha fechado. Filhos de `CreateProcess` herdam associação. Não há breakaway, kill-on-close, serviço, daemon ou segundo executável de produto.
2. **Mutex administrativo**, seguido pelo **mutex runtime**: continuam obrigatórios para cada efeito administrativo e substituição/remoção de arquivos. Job Object não substitui A3. O Main normal adquire runtime antes de ler a função e abrir serviços/bancos, mantendo o mutex global durante todo o lifecycle operacional e o lock Electron separado por perfil.
3. **Fence persistente**: `installationId`, `operationId`, `expectedGeneration`, tipo de pending e role. Helpers validam a fence sob ambos os mutexes; NSIS revalida seu snapshot depois de adquirir os locks e antes de remover/substituir arquivos. Nenhum comando de manutenção pode criar uma intenção nova a partir de parâmetros obsoletos.

O Job Object cobre o intervalo em que NSIS libera os mutexes para chamar um helper que os adquire por conta própria. Continua existindo enquanto houver membro vivo, mesmo se o criador morrer. Portanto um tombstone de processo vivo não pode ser consumido por uma reinstalação independente. Não se usa PID, sleep, prazo de expiração ou retry como prova de exclusão.

Manutenção exige `enterInstallationOperation() == delegated`, além de elevação/imagem/ACL/manifesto. Invocação administrativa independente pode iniciar confirmação inicial, que tem sua própria fence, mas não pode atuar como manutenção NSIS. `--updated` em uninstaller independente também é rejeitado; o filho de upgrade legítimo pertence à árvore do installer que já detém os mutexes. São processos cooperantes do protocolo atual; um instalador legado que nunca implementou o protocolo não recebe garantia retroativa.

Referências de plataforma: [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [CreateJobObjectW](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw), [ReleaseMutex](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-releasemutex). Job membership e nested jobs precisam ser comprovados no ambiente efetivo; falha de admissão não ativa fallback.

## Ownership e conclusão

Os mutexes NSIS são adquiridos na worker das seções. Install libera nessa worker antes do helper final; uninstall acrescenta uma seção final obrigatória, invisível, que libera/fecha somente depois da seção padrão do Builder (arquivos, atalhos e registros). A página interna de componentes é pulada; não existe nova escolha de produto. `un.onGUIEnd` e `.onGUIEnd` não liberam esses mutexes. GUI e silencioso usam o mesmo código de conclusão.

`ReleaseMutex`/`CloseHandle` com erro encerram com falha. Abort/crash pode abandonar ownership; esse resultado é tratado explicitamente como recuperação necessária, nunca como aquisição normal bem-sucedida. A evidência persistente não é apagada para desbloquear o app. Handles de Job Object são liberados pelo sistema no término; fechar um handle não desassocia processos vivos. Nunca se chama `TerminateJobObject`.

## Estados e publicação

- Instalação inicial cria `pending/prepare-update`, generation 0, role null e UUIDs distintos de instalação/operação. Cancelamento ou extração incompleta deixa essa barreira. Novo installer só retoma esse bootstrap protegido reconhecido; estado órfão/legado ambíguo permanece bloqueado.
- Depois de binários e registro instalados, o helper verifica atalhos bootstrap e confirma `unconfigured`, generation 1. A escolha `player`/`combined` continua exclusivamente no aplicativo. `synchronizeBootstrapShortcuts` é o único writer dos atalhos bootstrap.
- Update preserva intenção pendente de confirmação/troca, sem substituir `operationId`; repair retoma-a. Update sem função continua null/unconfigured. Geração e revisão só avançam pelos commits previstos.
- Uninstall grava tombstone com função e geração anteriores; remove somente atalhos comprovados e arquivos de aplicação. SQLite/userData não são abertos nem removidos. Reinstall, depois do término da árvore anterior, copia binários sob locks e restaura somente a role registrada, ou null. Commit avança geração uma vez; repetição idempotente reconhece apenas a conclusão correspondente.
- Confirmação inicial inclui `installationId` no broker e no helper, impedindo um pedido UAC antigo de confirmar outra instalação com geração coincidente. Cancelamento recupera o gate e relê o estado antes de continuar.
- Helpers retornam código ao NSIS e não deixam um wizard silencioso esperando um diálogo Electron. Ocupação runtime tem resultado distinguível; erros genéricos continuam falha fechada. Não há writer SQLite no ramo administrativo.

## Matriz de interleavings

| Cenário | Estado exigido / comprovação |
|---|---|
| Install × install | Só uma árvore entra antes da inicialização do manifesto. Prova nativa de contenção; dois installers instalando de fato ainda exigem runner descartável. |
| Install × uninstall | Segunda árvore recusa, inclusive no handoff helper→NSIS. Job/descendência nativos + fonte NSIS compartilhada; integração instalada separada. |
| Uninstall × reinstall | Reinstall não consome T enquanto U ou seus descendentes vivem. Após morte do último membro, pode recuperar T sob gates e fence exata. Prova de parent crash/helper sobrevivente e retry. |
| Update × uninstall | Uninstaller interno só é admitido como descendente de upgrade, com mutexes do pai mantidos. Uninstaller externo não recebe bypass por `--updated`. Update instalado N-1 ainda obrigatório. |
| Maintenance × startup | Startup anterior faz manutenção falhar por runtime ocupado; pending posterior faz startup recusar antes de SQLite. Nenhum kill. Gate/Electron e caso negativo instalado são provas distintas. |
| Uninstall × startup | Mesmo contrato: runtime ativo recusa helper antes do tombstone; depois de T, startup falha fechado. Remoção inteira retém mutexes. |
| Cancelamento antes das seções | Nenhuma troca de função; bootstrap novo pode conservar pending 0 para retomada. Cancelamento UI/UAC real não é inferido de testes unitários. |
| Crash após pending/tombstone | Estado continua bloqueado. Enquanto qualquer membro vive, nova árvore não entra. Após término, retry reconcilia o mesmo ID. |
| Crash antes/depois da aquisição | Antes: nenhuma mutação autorizada; depois: abandono explícito, não sucesso. Testes nativos e NSIS de falha/aborto. |
| Crash durante remoção | Locks sobrevivem até término da thread/processo e T permanece. Binário parcial pode exigir reinstall; não há remoção do manifesto ou perfil como recuperação. Produto instalado: obrigatório em descartável. |
| Retry de mesmo operationId | Pending exato retoma; conclusão correspondente é reconhecida uma vez. Outra instalação/geração/tipo não é aceita por coincidência de UUID. |
| Operação obsoleta após nova geração | Helpers recusam antes de efeitos; NSIS revalida antes da primeira remoção. Probe altera fixture entre leitura e remoção e exige sentinel preservado. |
| Instalação substituída com generation 0 | Confirmação UAC inclui installationId; UUID de instalação divergente bloqueia. Teste unitário + UAC real separado. |
| Término do helper antes do NSIS | Job do NSIS continua ativo durante a seção. Término do pai antes do helper mantém a árvore ocupada até o último descendente sair. Prova com handles/processos reais. |

## Limites dos testes e smoke

O runner oficial mantém snapshot/NTFS/cleanup e inclui provas de mutex N-API, árvore de processos Electron e probes NSIS. Probes executam a fonte real das funções/seção final e includes de fence/job em diretórios temporários; somente nomes globais e ACL da fixture mudam para o SID do teste, além de trace. Eles não instalam o produto nem tocam Program Files, ProgramData ou Registro. Não provam ACL SYSTEM/Administrators elevada, UAC ou duas contas.

O smoke instalado exige GitHub-hosted Windows. Executa cópia hash-verificada do uninstaller em diretório temporário exclusivo com `_?=` apontando à fixture de instalação, aguarda o processo efetivo e mantém assertions de pasta, registros, links e hashes userData. Cleanup preserva fixtures se houver processo vivo ou se o Job Object administrativo não tiver terminado; não transforma resíduos em PASS. [Contrato de linha de comando NSIS](https://nsis.sourceforge.io/Docs/Chapter3.html).

Instalação/upgrade/uninstall do produto, UAC, ACL entre contas, duas sessões, reboot e artefatos N-1 reais continuam obrigações de homologação. Sua ausência pode permitir somente desenvolvimento/PR de validação sob gate explícito; nunca distribuição ou aceite automático E1–E5.

## Recuperação e limites adicionais

O installer verifica proprietário, DACL e ausência de reparse points do controle antes de confiar em um pending, repetindo essa verificação sob mutexes. Se uma extração/remoção interrompida já eliminou o helper antigo, somente pending canônico reconhecido permite copiar novamente os binários sob exclusão; o helper novo valida o schema completo e efetiva o commit. Estado órfão ready, conflito per-user, geração/instalação divergente ou corrupção não autorizam criação de nova autoridade. Corrupção irrecuperável do manifesto exige diagnóstico explícito; não se apaga o controle como desbloqueio automático.

Retries após ACK perdido de confirmação/troca/restauração reconhecem o commit exato sem repetir mutações dos atalhos. Os testes substituem o writer por uma porta que lança erro no retry confirmado para detectar efeitos indevidos. Bootstrap sem função só confirma após sincronizar os links genéricos; falha mantém pending e retry conserva o ID. A sincronização de arquivos continua pertencendo ao NSIS, sem writer SQLite no helper e sem alteração de banco por reinstalação.

O smoke de preservação usa o userData padrão **real da conta descartável do GitHub-hosted**, previamente inexistente. Um diagnóstico Electron Windows confirmou que mudar `APPDATA` não altera `app.getPath('appData')`; portanto o smoke usa o known folder da conta, confere o caminho reportado pelo Main empacotado e nunca adota um perfil já existente. O cleanup pode apagar somente esse perfil novo confirmado, sem reparse point e após término comprovado das fixtures; não remove o diretório pai AppData. A recusa de uninstall com Main ativo exige exit32, manifesto byte a byte preservado e Main vivo. Esse caminho instalado ainda depende da execução hosted e continua NOT RUN localmente.

## Repetição segura e homologação

- Foco sem produto instalado: `npm run test:e2e:multi-instance:windows -- --installation-coordination --approve-untracked`, com `KARAOKE_QUEUE_WIN_CHECKOUT` em checkout NTFS exclusivo conforme o runner oficial. Inclui testes de estado/admin/bootstrap, addon real de fixture, árvore de processos e probes NSIS, sem NSIS instalado.
- Regressão afetada: `npm run test:e2e:multi-instance:windows -- --approve-untracked`.
- Candidato sem instalar: `npm run package:windows:candidate -- --approve-untracked`; a saída exige build NSIS completo, selo e verificador. A configuração de download usa o checksum oficial win32-x64 de `electron/checksums.json` do pacote npm travado, sem desabilitar SHA/TLS; ausência/hash inválido falha. Isso evita depender de novo fetch de SHASUMS quando o ZIP verificado já está em cache.
- Produto instalado: workflow PR existente `pr-validation.yml`, em GitHub-hosted Windows descartável. Verificar logs dos smokes empacotado e install/uninstall/reinstall e baixar artifact somente após todos os jobs PASS. Nenhum dispatch foi autorizado/executado nesta correção.
- Homologação posterior: GUI/cancelamento/UAC aceito e negado/outra credencial, duas contas/sessões, ACL de produção com tokens distintos, upgrade N-1 real, crash durante cada trecho de remoção/publicação e retry com operação antiga. Repetir a matriz com o **mesmo candidato** e registrar hashes antes/depois dos perfis e manifesto. Quando não houver ambiente adequado, manter NOT RUN.

Os probes de fonte compartilhada e a prova Win32 de lifecycle sustentam a correção estrutural; não substituem executar o produto instalado em ambiente descartável. Referências: [NSIS threading](https://github.com/kichik/nsis/blob/master/Source/exehead/Ui.c), [libuv process detached](https://github.com/libuv/libuv/blob/v1.x/docs/src/process.rst), [Electron Builder configuração](https://www.electron.build/v26/docs/api/electron-builder.interface.configuration/).
