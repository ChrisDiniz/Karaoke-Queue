# Biblioteca local de vídeos

**Status:** configuração e indexação local **IMPLEMENTED** na Fase 3; seleção da pasta, atualização do scan e consulta do estado pela UI Player-only **IMPLEMENTED** na Phase 5F-B. Indexação e lifecycle foram **VERIFIED** no Windows nativo. Reprodução de amostras MP4 H.264/AAC está registrada em [Player Playback](player-playback.md); outras mídias não são consideradas compatíveis apenas por extensão e permanecem **NOT VERIFIED**.

> **Transição:** este documento descreve serviços e integrações existentes do Player legado. Biblioteca, resolução e validação continuam candidatas à infraestrutura compartilhada; as referências a UI/opções Player-only não especificam a nova interface Standalone. Consulte a [especificação V1](standalone-one-screen-player.md) e o [roadmap](standalone-player-roadmap.md).

Este documento descreve o que existe em `src/video-library.ts`, `src/video-library-configuration.ts`, `src/video-library-service.ts` e sua inicialização em `main.ts`. O serviço identifica candidatos pelo nome do arquivo; não comprova que o arquivo contenha vídeo/áudio decodificável nem que esteja sincronizado com letras.

## Propriedade e inicialização

- O acesso a filesystem e os caminhos completos permanecem no processo Main.
- O modo Controller não lê a configuração da biblioteca nem varre diretórios.
- Player e Combined leem configuração e aguardam o scan inicial antes da abertura do banco operacional Controller e da criação de janela. Player não abre SQLite operacional nem registra IPC Controller; Player-only oferece UI de controle/configuração dedicada. Combined mantém uma única conexão operacional Controller e uma única biblioteca local em memória.
- Configuração inválida falha o startup Player-capable; a configuração inválida não é reescrita e o SQLite operacional não é aberto por essa falha.
- No shutdown, o serviço é fechado e deixa de publicar resultados. O índice não sobrevive ao processo: é reconstruído do filesystem a cada startup.

No Player-only, a interface permite escolher/alterar uma pasta pelo diálogo nativo do Main, solicitar nova indexação e consultar o resumo do inventário. A configuração é persistida pelo serviço existente; o Renderer não recebe caminho privilegiado. A UI equivalente em Combined e gestão de múltiplas raízes continuam fora do escopo atual.

## Configuração

`video-library.json` fica no diretório `userData`, separado do banco e de `operating-mode.json`. Schema estrito atual:

```json
{
  "version": 1,
  "roots": ["/caminho/absoluto/da/biblioteca"]
}
```

Arquivo ausente significa `{"version":1,"roots":[]}` e não é criado pela leitura. A lista aceita até 32 caminhos absolutos distintos, normalizados sem exigir que existam no momento da configuração (drives/pastas podem estar temporariamente indisponíveis). Chaves extras, versão desconhecida, caminhos relativos, duplicatas, valores inválidos, arquivo não regular, conteúdo acima do limite, JSON inválido ou UTF-8 inválido produzem erro explícito e preservam o arquivo existente.

A função de escrita valida primeiro e usa temporário exclusivo no mesmo diretório, `fsync` do arquivo e rename para substituição; falha remove o temporário e preserva a configuração anterior. Em POSIX o temporário é criado com modo `0600`. No Player-only, a seleção de pasta pela UI chega a essa configuração por IPC validado e diálogo nativo do Main.

## Regras de indexação

O scan é recursivo, determinístico na ordem de diretórios e considera extensões `.mp4`, `.mkv`, `.webm`, `.avi`, `.mov`, `.mpeg`, `.mpg` e `.wmv`, sem diferenciar maiúsculas/minúsculas. Essa é uma lista de extensões candidatas, não uma declaração de suporte a contêiner ou codec.

O nome base deve começar por exatamente cinco dígitos ASCII. Após o código, o nome deve terminar ou ter espaço, hífen ou underscore. Exemplos aceitos incluem `01001.mp4`, `01001 - Nome.mkv` e `01001_nome.MP4`. `1001.mp4`, `010012.mp4`, `x01001.mp4` e `01001Nome.mp4` não são candidatos válidos. Caminhos/passagens de diretório não são aceitos pelo parser de nome.

O índice usa o código de cinco dígitos do vídeo como identificador canônico. O catálogo aceita número de 1 a 5 dígitos sem zeros à esquerda, preservado originalmente e preenchido somente durante matching. A função compartilhada `normalizeCatalogCodeForVideoMatch()` canonicaliza, por exemplo, `1001` para `01001`; não há inferência por título/arquivo nem escolha arbitrária em caso de ambiguidade.

Mais de um caminho para o mesmo código resulta em `ambiguous`; nenhum candidato é escolhido arbitrariamente. O serviço mantém códigos conhecidos em memória, então uma remoção observada após scan completo passa a `missing`. Scan concluído com lista de raízes vazia produz snapshot `ready` vazio. Uma raiz inacessível produz snapshot `degraded`; o conteúdo anterior daquela raiz é retido como `unknown`, sem afirmar que os vídeos desapareceram. Diagnósticos usam índice da raiz e caminhos relativos, nunca caminho absoluto.

### Estados e snapshot

Cada item pathless inclui `musicCode`, `availability` e `candidateCount`. Estados possíveis:

| Estado | Significado observado |
|---|---|
| `available` | Um candidato único foi encontrado em scan completo; lookup ainda revalida o arquivo. |
| `ambiguous` | Mais de um candidato corresponde ao código; não há seleção automática. |
| `missing` | No snapshot, código previamente conhecido não aparece após um refresh completo. Um código nunca visto só é declarado ausente no snapshot após scan `ready`. Um lookup pontual também pode retornar `missing` ao confirmar que o arquivo foi removido, mas não altera o snapshot publicado; ele só refletirá `missing` após refresh completo. |
| `unreadable` | O candidato existe, mas falhou ao ser aberto/validado como arquivo regular. |
| `unknown` | Estado não pode ser confirmado: antes do scan, scan incompleto, raiz indisponível ou divergência desde o último snapshot. |

O snapshot tem `version: 1`, `revision` SHA-256 determinística do estado público (sem timestamp e sem caminhos), `scanStatus`, `scannedAt`, contagens e itens. A revisão identifica o inventário pathless e pode manter o mesmo valor em scans equivalentes. `scannedAt` registra a conclusão de cada scan; portanto a revisão não substitui o horário.

O snapshot é uma fotografia do último scan concluído. `lookup()` revalida o candidato no filesystem e pode retornar `missing`, `unreadable` ou `unknown` antes que um novo scan atualize inventário/revisão. Consumidores devem considerar `scannedAt` e `scanStatus`; não há sincronização Controller/Player implementada.

## Proteções de filesystem e limite de segurança

O serviço verifica raízes e candidatos com `lstat`/`realpath`, contenção sob a raiz canônica, dispositivo, identidade de diretórios visitados e consistência do arquivo aberto. Symlinks e reparse points são ignorados; diretórios em outro dispositivo não são percorridos. Quando disponíveis, `O_NOFOLLOW` e `O_NONBLOCK` são usados na abertura. O lookup revalida caminho, tipo, identidade e metadados do arquivo antes de retornar o caminho ao chamador Main.

Snapshots e diagnósticos públicos não carregam caminhos absolutos. O resultado interno `available` de `lookup()` contém `filePath`; por isso esse contrato deve continuar Main-only e não ser exposto diretamente ao Renderer ou à rede.

Essas verificações reduzem traversal e troca por symlink, mas não eliminam todas as corridas TOCTOU entre validação e uma futura abertura/uso pelo engine. Quando houver playback, a engine deverá receber um arquivo já resolvido por componente privilegiado e a abertura real também precisará tratar substituição/movimentação. Arquivos de mídia não são decodificados nem inspecionados por conteúdo neste serviço.

## Fora do escopo atual

- CSV, metadados de artista/título, importação e matching de códigos CSV.
- Persistência SQLite do índice ou dos diagnósticos; somente raízes são persistidas em JSON.
- Transferência de arquivos, inventário remoto, HTTP/WebSocket, pairing ou protocolo LAN.
- UI equivalente em Combined e gestão avançada de múltiplas raízes.
- UI equivalente em Combined e gestão avançada de múltiplas raízes.

Metadados CSV sem vídeo não devem ser tratados como reproduzíveis. Um vídeo sem metadados CSV continua disponível pelo código, sem inventar artista ou título; a ausência de CSV não bloqueia a reprodução Player-only.

## Validação disponível

`tests/video-library.test.ts` cobre parser/extensões, configuração e preservação de erro, scan recursivo, snapshot sem caminhos absolutos, duplicatas, remoções, revisão determinística, raiz indisponível, estado ausente/desconhecido e revalidação do lookup. `tests/video-library-electron.ts`, executado por `npm run test:e2e:video-library:headless`, cobre o isolamento do modo Controller, scan e restart Player, Combined e falha de configuração preservando o banco Controller.

**Linux/WSL2:** compile, `npm run test:unit`, unitários da biblioteca 15/15, E2E da biblioteca e QA passaram. **Windows nativo: PASS** pelo runner central com fingerprint verificado: testes unitários de biblioteca 15/15; E2E Player/Controller/Combined e restart passaram. A validação exercitou junctions internas/externas, extensões com diferenças de casing, reinício e isolamento/preservação de SQLite. Ela valida filesystem e lifecycle; não valida permissão negada em arquivo, decodificação de codec ou reprodução A/V.

## Estados e UI

O shell Player-only apresenta estado da biblioteca, contagem, problemas reconhecidos, escolha/alteração de pasta e atualização do scan conforme o frame Doop aprovado pelo proprietário para implementação. O backend fornece snapshots do inventário; não há progresso granular de scan nem UI equivalente em Combined. A lista de extensões identifica candidatos, não compatibilidade de codec.
