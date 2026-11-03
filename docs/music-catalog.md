# Catálogo musical CSV

> **Transição:** este documento registra os serviços e a integração de catálogo já existentes, inclusive a UI do Player legado. Parser, normalização e persistência são candidatos à reutilização; este texto não define as opções nem a interface da nova V1 Standalone. Consulte a [especificação V1](standalone-one-screen-player.md) e o [roadmap](standalone-player-roadmap.md).

## Status

- **IMPLEMENTED:** parser CSV, validação, persistência Controller e Player-only isolada, substituição atômica, busca interna e associação pathless com inventário local em Combined/Player.
- **IMPLEMENTED:** UI Player-only para importar/substituir o CSV opcional e mostrar metadados disponíveis na música atual e na sequência manual.
- **PLANNED:** UI de busca/importação do catálogo no Controller, transporte de inventário remoto e integração de metadados nos cartões da fila Controller.
- **NOT VERIFIED:** compatibilidade/reprodução de mídias fora das amostras efetivamente testadas. Indexação de um nome/extensão não prova que o engine reproduz determinado arquivo.

No modo Player-only, a interface aprovada permite importar/substituir CSV por diálogo nativo e exibe título/artista quando disponíveis; catálogo continua opcional e não determina disponibilidade de vídeo. A busca de catálogo para a operação Controller e a exibição de metadados nos cartões da fila aguardam integração visual própria.

## Responsabilidades e modos

| Modo | Catálogo | Vídeos |
|---|---|---|
| Controller | Importa, persiste e pesquisa metadados no SQLite Controller. | Não varre arquivos locais. Sem LAN implementada, disponibilidade é `unknown`. |
| Player | Usa o banco dedicado `player-music-catalog.sqlite`; não abre `karaoke.sqlite` nem tabelas operacionais. CSV é opcional. | Mantém a biblioteca local em memória e determina disponibilidade. |
| Combined | Reutiliza o mesmo catálogo Controller e a biblioteca Player local. | `MusicCatalogService` deriva uma view pathless do catálogo e do inventário; não copia disponibilidade para SQLite. |

O Controller continua autoridade sobre sessões, mesas, cantores, apresentações, fila e histórico. O Player não abre nem escreve o estado operacional Controller. Combined usa a mesma conexão SQLite Controller e uma instância da biblioteca local.

Módulos atuais:

- `src/music-catalog.ts`: parser puro, validação, tipos, normalização de texto/códigos e revisão de conteúdo. Não acessa filesystem, SQLite nem Electron.
- `src/music-catalog-service.ts`: lê o arquivo de catálogo no Main, serializa imports, chama o repositório, pesquisa e deriva disponibilidade pelo contrato do inventário.
- `database.ts`: repositório de catálogo compartilhado; schema v5 Controller e banco Player-only restrito a tabelas de metadados.
- `src/video-library.ts` e `src/video-library-service.ts`: propriedade Player sobre os caminhos, índice e disponibilidade. Veja [Biblioteca local de vídeos](video-library.md).

## CSV aceito

Os cabeçalhos lógicos exigidos são `artista`, `numero` e `nome_musica`, cada um exatamente uma vez. O parser aceita espaços externos e diferenças de maiúsculas/minúsculas nos cabeçalhos, inclusive quando as colunas estão em ordem diferente. Não tenta adivinhar aliases ou colunas por conteúdo.

A amostra real validada usa UTF-8 com BOM, ponto e vírgula e o cabeçalho `artista;numero;nome_musica`.

O parser aceita UTF-8 estrito, BOM opcional, delimitador ponto e vírgula ou vírgula identificado pelos três cabeçalhos, LF/CRLF, campos entre aspas, aspas escapadas (`""`), delimitadores e quebras de linha dentro de campos citados. Aspas malformadas, UTF-8 inválido, caracteres de controle, cabeçalho ausente/ambíguo ou número incorreto de colunas rejeitam o arquivo inteiro. Linhas vazias são ignoradas; valores de artista/título em branco são permitidos.

Limites preventivos atuais:

- arquivo: 32 MiB;
- registros: até 100.000;
- campo: até 4.096 caracteres;
- busca: até 256 caracteres;
- página: 50 resultados por padrão, máximo 100; offset limitado a 1.000.000;
- diagnósticos de metadados vazios: contagens completas e até 500 avisos de linha retornados.

Um arquivo vazio ou somente com cabeçalho não substitui o catálogo. Código inválido/duplicado, erro estrutural, limite excedido ou erro de leitura cancela a importação completa. O erro contém código e, quando disponível, linha/campo; não inclui o caminho absoluto nem valores CSV desnecessários.

## Número musical e metadados

`numero` é um identificador textual ASCII de 1–5 dígitos sem zero à esquerda (`^[1-9][0-9]{0,4}$`). O parser remove espaço externo do campo e preserva o restante do número como string; nunca converte para `number`.

`videoCode` é derivado somente para associação: o identificador original é preenchido à esquerda até cinco caracteres. Exemplo: CSV `1001` continua sendo `1001`, e seu `videoCode` é `01001`. A função compartilhada `normalizeCatalogCodeForVideoMatch()` é a única normalização de associação; o vídeo usa um prefixo canônico de exatamente cinco dígitos conforme as [regras de indexação](video-library.md#regras-de-indexação).

Artista e título são opcionais. O valor vazio ou composto só por espaços é armazenado como `null`; não é preenchido a partir do nome do arquivo. Valores presentes recebem NFC, trim e colapso de espaços repetidos. Formas de busca ficam separadas das formas apresentadas: busca usa decomposição Unicode, remove marcas de acento, converte para minúsculas pt-BR e normaliza espaços.

O conteúdo amostrado possui 13.988 registros; nele foram observados dois artistas ausentes, sete títulos ausentes, nenhum código duplicado/inválido e códigos de quatro/cinco dígitos. As métricas reais são verificadas pelo teste opcional da coleção local; nenhum CSV ou caminho pessoal é versionado.

## Persistência e importação

No Controller/Combined, o catálogo fica em tabelas próprias no banco SQLite Controller schema v5:

- `music_catalog`: código original como chave primária textual, `video_code` único, artista/título nullable e formas normalizadas;
- `music_catalog_metadata`: revisão SHA-256, horário da importação e contagem do snapshot ativo.

Não há foreign key/cascade do catálogo para sessões, entradas de fila ou histórico. Migrações existentes v1, v2, v3 e v4 progridem sequencialmente até v5; tabelas e registros operacionais são preservados. A persistência Controller/Combined usa a mesma conexão `DatabaseSync` já aberta pelo Controller/Combined, sem segundo writer operacional.

Player-only persiste o mesmo formato de catálogo em `player-music-catalog.sqlite`, sob `userData`, por um repositório SQLite separado que cria somente `music_catalog` e `music_catalog_metadata`. O banco não contém sessões, mesas, fila, apresentações ou histórico. Parser e normalização são os mesmos; arquivo ausente significa catálogo opcional não configurado. A biblioteca local continua sendo a única fonte de disponibilidade de vídeos. Combined não cria esse segundo arquivo e permanece com uma única conexão operacional.

Cada importação bem-sucedida **substitui o catálogo inteiro**. O serviço lê o arquivo, valida e prepara todos os registros antes da transação. Depois, uma transação SQLite única apaga e reinsere somente as linhas de catálogo e grava revisão/horário/contagem. O serviço confere a revisão e a contagem após commit e só então devolve sucesso. Falha de parse, constraint, leitura ou commit mantém o catálogo anterior por rollback e não altera sessões, fila, apresentações, histórico, cadência, licença ou arquivos de vídeo. Catálogo vazio nunca é uma substituição implícita.

Imports são serializados desde a ordem de chamada — leitura, parse e commit — para que uma solicitação posterior não seja substituída por uma antiga que terminou mais tarde. O encerramento impede novos imports e aguarda os já aceitos antes de fechar SQLite. Busca lê registros/página e revisão no mesmo snapshot de leitura. A revisão é SHA-256 do conteúdo semântico ordenado por número, usando código original e metadados normalizados; reimportar conteúdo semanticamente igual mantém a revisão. O caminho/nome absoluto do CSV não é persistido.

A leitura no Main exige caminho absoluto, arquivo regular, tamanho permitido e rejeita symlink/reparse detectável. Usa `O_NOFOLLOW`/`O_NONBLOCK` quando disponíveis, valida identidade e compara identidade, tamanho, mtime e ctime de alta precisão antes/depois da leitura; também confirma que o caminho ainda aponta ao mesmo arquivo. Alteração detectada retorna `FILE_CHANGED` antes de parse/persistência. Isso evita aceitar alterações locais observáveis durante a leitura, mas não constitui snapshot atômico contra qualquer writer externo ou todas as condições TOCTOU do filesystem.

## Busca e contrato de resultado

`MusicCatalogService.search(query, {limit, offset})` dá suporte a:

- texto parcial, literal, case-insensitive e accent-insensitive em artista e título;
- prefixo numérico ASCII de até cinco dígitos em código original e código canônico de vídeo;
- ordenação estável por comprimento e valor binário do código original;
- paginação limitada e resultados vazios para query vazia.

`%` e `_` são caracteres de texto literal. Busca textual executa `instr` nas colunas normalizadas dentro do SQLite; não carrega a coleção inteira para cada consulta e não usa FTS5. Para a amostra de aproximadamente 14 mil registros, essa escolha evita adicionar dependência/infraestrutura; se volume e medições futuras justificarem, reavaliar antes de introduzir índice de texto.

Cada item da view interna contém `musicNumber` original (ou `null` sem registro CSV), `videoCode` canônico, `artist`/`title` nullable, `metadataAvailable` e `videoAvailability`. A página inclui `catalogRevision`, `inventoryRevision`, estado do inventário, total e paginação. Não inclui caminho de arquivo.

`lookupByVideoCode(code)` consulta exatamente um código e também aceita a forma CSV de 1–5 dígitos para normalização. É o caminho de consulta para um vídeo sem CSV: retorna o código canônico, metadados `null`/indisponíveis e a disponibilidade observada. Em inventário `ready`, revalida o arquivo pela biblioteca Player e devolve `unknown` se a revisão mudar durante a operação. Uma disponibilidade confirmada como `missing` só é derivada de scan completo; inventário desconhecido/degradado não é tratado como ausência confirmada e duplicata permanece `ambiguous`.

Os ciclos do catálogo e do inventário são independentes. Reimportar CSV não varre, apaga ou renomeia vídeos; rescan não escreve metadados CSV. Controller-only sem inventário deixa disponibilidade desconhecida. Não há adapter remoto; quando existir, deverá fornecer dados de inventário sem caminhos e manter revisão separada.

## Política da fila

Busca por artista, título ou número é somente uma capacidade de descoberta: ajuda o operador a encontrar o código e consultar disponibilidade. **Buscar nunca inclui uma música na fila nem cria turno/apresentação.** A inserção permanece pelo fluxo existente baseado no número/código, fora de `MusicCatalogService`. Um resultado encontrado só chega à fila se o operador usar separadamente esse fluxo.

Vídeos sem metadados CSV permanecem consultáveis pelo código e não recebem artista/título inventados. Isso não altera o algoritmo Round Robin, debut cadence, pins, prefixo congelado, sessão nem histórico. A política de admitir na fila um registro CSV cujo vídeo esteja confirmado como ausente continua sendo uma decisão de produto separada; esta fase não muda a admissão.

Dados históricos atuais guardam números de música e não snapshot de artista/título. A substituição não reescreve o histórico. Se uma fase futura exigir exibição da descrição tal como existia no momento da apresentação, deverá definir snapshot próprio sem tornar o catálogo atual uma dependência mutável do histórico.

## Segurança e limitações

CSV é entrada não confiável. Parser e limites precedem a transação; duplicatas/códigos inválidos não são escolhidos silenciosamente; SQL usa parâmetros; valores são armazenados como texto, sem executar fórmula/HTML. A UI Player-only renderiza artista/título como texto, não os interpola como HTML. Não há exportação CSV/planilha nesta fase.

No Player-only, importação e substituição estão expostas pelo contrato tipado do Preload, usando diálogo do Main; nenhum caminho arbitrário é aceito do Renderer. A interface não oferece busca ampla do catálogo. Disponibilidade não comprova compatibilidade de codec. LAN, pairing e reconciliação Controller permanecem não implementados.

## Testes

`tests/music-catalog.test.ts` cobre parser, BOM/UTF-8, delimitadores/citações, códigos, metadados ausentes, limites, busca, paginação, ordenação, substituição, rollback SQLite, preservação operacional, import concorrente, shutdown e associação com inventário. `tests/database-migration.test.ts` cobre migração v1–v4 para v5 sem alterar estado existente.

`tests/music-catalog-electron.ts` usa Electron/Playwright reais e perfis isolados para verificar inicialização Controller/restart, Player com banco local de metadados sem banco operacional, e Combined. `tests/music-catalog-sample.ts`, via `npm run test:catalog:sample`, valida a coleção local em um banco temporário e verifica que os originais permanecem inalterados; seus arquivos não são parte do repositório.

Na validação da Phase 5F-A, `npm run test:unit` e `npm run test:e2e:music-catalog:headless` passaram em Linux. A suíte geral do runner Windows também passou após sincronizar/verificar snapshot, incluindo os testes unitário e Electron do catálogo: Player-only mantém o banco isolado sem `karaoke.sqlite`, Controller conserva persistência e Combined mantém o catálogo na conexão operacional única. O teste de hard link confirmou rejeição de alias para o banco operacional.

Comandos declarados em `package.json`:

- `npm run test:unit`
- `npm run test:e2e:music-catalog:headless`
- `npm run test:catalog:sample` (requer caminho local fornecido por variável de ambiente)
- `npm run test:e2e:multi-instance:windows` (runner central WSL2 → checkout NTFS; verificar o resultado da execução, não presumir PASS)

O runner Windows Phase 4 passou após validar o fingerprint: migrações v1–v4, unitários de modo (7/7), biblioteca (15/15) e catálogo (20/20), além de E2E nativos de single-instance/foco, Controller/Player/Combined, biblioteca e catálogo. A amostra CSV e os 21 arquivos reais foram validados separadamente em WSL2/Linux; a coleção original não foi transferida ao checkout Windows.

Como ensaio orientativo no WSL2/Linux, depois de importar os 13.988 registros em SQLite temporário, uma consulta por código, um prefixo de artista e um prefixo de título retornaram páginas limitadas a 50 em aproximadamente 5,7 ms, 6,2 ms e 8,6 ms, respectivamente. São observações de uma execução, sem limiar/SLA; servem para confirmar que a busca permanece no SQLite e não materializa todo o catálogo por chamada.

## Interface

Player-only possui interface Doop implementada para importar/substituir o CSV e exibir metadados associados à música atual e aos itens da sequência local. Busca por artista/título/código no Controller, estados de disponibilidade na interface do catálogo e cartões de fila com metadados permanecem pendentes de desenho/integração próprios. Qualquer busca futura deve apresentar código/disponibilidade sem adicionar automaticamente à fila; a inserção continua sendo uma ação separada do Controller.
