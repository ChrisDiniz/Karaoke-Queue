# Planejamento V1 — Player Only (Standalone)

## 1. Objetivo

Implementar um modo de operação simplificado para o **Player Only**, funcionando de maneira independente, sem conexão com um Controller remoto.

O operador poderá adicionar músicas à fila e controlar a reprodução utilizando apenas o teclado, em uma única tela.

### Princípios

- Operação simples, semelhante aos sistemas tradicionais de karaokê.
- Controle da reprodução por atalhos de teclado.
- Reprodução automática conforme a ordem da fila.
- Adição de músicas por código numérico.
- Interface discreta, sem interromper a reprodução durante a entrada de códigos.
- Design da interface definido separadamente no Doop.
- Implementar somente as funcionalidades previstas neste planejamento.

---

## 2. Comandos e atalhos

| Ação | Atalho | Comportamento |
|---|---|---|
| Digitar código | `0–9` | Abre automaticamente o painel de entrada e insere os números digitados. |
| Adicionar música | `Enter` | Confirma o código. Se o Player estiver ocioso, inicia a contagem regressiva inicial; durante reprodução ou pausa, adiciona ao final da fila; durante a celebração, adiciona ao final sem iniciar antes do término dela. |
| Priorizar música | `P` | Confirma o código. Se o Player estiver ocioso, inicia a contagem regressiva inicial; durante reprodução ou pausa, coloca a música na primeira posição da fila pendente; durante a celebração, prioriza a música sem iniciar antes do término dela. |
| Pausar / Continuar | `Espaço` | Alterna entre pausar e continuar a reprodução atual. Durante a contagem regressiva inicial ou a celebração, pausa e retoma o respectivo temporizador sem chamar Pause/Resume do vídeo. |
| Próxima música | `Ctrl + →` | Encerra a reprodução atual e inicia a próxima música disponível somente quando uma música estiver carregada e efetivamente em reprodução. |
| Encerrar reprodução e retornar ao início | `Ctrl + Espaço` | Abre uma confirmação sem encerrar a reprodução. Enquanto o modal estiver aberto, a música continua. `Esc` cancela e preserva reprodução e fila. `Enter` confirma o encerramento controlado, limpa a música atual, a fila e as prioridades e retorna ao estado ocioso, sem celebração nem avanço automático. Transições pendentes são canceladas com segurança; acervo e catálogo são preservados. Este comando não é incluído no menu de `Esc` nesta versão. |
| Reiniciar música | `R` | Reinicia a música atual desde o início. |
| Mostrar informações da música atual | `I` | Exibe por 3,5 segundos o número e as informações disponíveis da faixa atual, sem alterar a reprodução ou a fila. Se os metadados não estiverem disponíveis, os campos Música e Artista indicam “Dados indisponíveis”. `Esc` fecha o painel antes do prazo; pressionar `I` novamente abre o painel ou renova seu temporizador. |
| Apagar dígito | `Backspace` | Remove o último número digitado, individualmente. |
| Abrir / Fechar menu | `Esc` | Fecha o painel de informações da faixa ou o painel numérico, quando aberto; sem painel, abre/fecha o menu principal conforme o contexto. |

---

## 3. Estados do Player

O Player terá três estados operacionais principais.

Contagem regressiva, carregamento e celebração são fases transitórias, não novos estados operacionais.

### 3.1. Ocioso

- Nenhuma música está sendo reproduzida.
- A fila está vazia.
- Enquanto nenhum código é informado, os campos Música e Artista ficam vazios.
- A primeira música adicionada inicia uma contagem regressiva de cinco segundos. A reprodução só pode começar depois que a contagem terminar e as condições técnicas necessárias estiverem satisfeitas.
- Não existe estado ocioso com músicas pendentes na fila.

### 3.2. Reproduzindo

- Existe uma música sendo reproduzida.
- Novas músicas adicionadas com `Enter` entram ao final da fila.
- Novas músicas adicionadas com `P` entram como próximas na ordem de reprodução.
- A reprodução atual não é interrompida pela adição de músicas.

### 3.3. Pausado

- A música atual permanece pausada na posição em que estava.
- A tela pode exibir uma indicação visual de "Pausado" ou "Pausa".
- Novas músicas podem ser adicionadas normalmente à fila.
- A adição de músicas ou prioridades não retoma a reprodução.
- `Espaço` continua a música do ponto em que foi pausada.

Durante a contagem regressiva ou a celebração, `Espaço` pausa o temporizador correspondente, sem iniciar, pausar ou retomar um vídeo.

### 3.4. Fases transitórias

**Contagem regressiva inicial:**

- Antes de iniciar a primeira música selecionada enquanto o Player está ocioso, exibe uma contagem real de cinco segundos.
- O número exibido progride até zero. A música não começa antes do fim da contagem nem antes das condições técnicas necessárias.
- `Espaço` congela o número e o tempo restante. Outro `Espaço` retoma do tempo restante, sem reiniciar a contagem.
- O vídeo não é iniciado nem pausado durante essa fase.

**Carregamento:**

- A tela de carregamento aparece somente enquanto houver preparação técnica real do vídeo.
- Não acrescenta espera e não representa a contagem regressiva nem a celebração.
- A UI recebe da camada autoritativa informação suficiente para identificar o carregamento real e a faixa alvo.

**Celebração após término natural:**

- Após um EOF natural validado, exibe a celebração por aproximadamente cinco segundos. Interrupção, erro ou avanço manual não são término natural.
- Quando houver uma próxima música, a celebração informa o tempo restante e a transição para ela. Se não houver próxima música, não anuncia uma faixa inexistente.
- `Espaço` congela o temporizador e o retoma do tempo restante. Não chama Pause/Resume do vídeo que já terminou.
- Se houver músicas pendentes ao fim da celebração, inicia a primeira conforme a fila autoritativa atualizada, diretamente e sem outra contagem regressiva.
- Se não houver músicas pendentes ao fim da celebração, retorna ao estado ocioso existente, sem tela adicional.
- Durante a celebração, `Enter` adiciona ao final da fila e `P` insere na primeira posição. Nenhuma adição reinicia a música encerrada; a fila é consultada novamente quando o temporizador termina.
- A cada celebração, sorteia uma mensagem do conjunto aprovado abaixo e a mantém durante essa celebração. O texto não avalia a voz ou a apresentação, não altera a faixa e não afeta a ordem da fila.

**Mensagens da celebração:**

1. O palco foi todo seu!
2. Você brilhou até a última nota!
3. Aplausos para você!
4. Que apresentação!
5. Você fez bonito do início ao fim!
6. Que energia no palco!
7. Você fechou com chave de ouro!
8. Parabéns pelo show!
9. Que voz, que presença!
10. Você arrasou!
11. Essa música ganhou vida com você!
12. Uma salva de palmas para essa interpretação!
13. O microfone agradece!
14. Essa foi para cantar junto!
15. A última nota foi especial!
16. Você deu vida a essa canção!
17. Que final de arrepiar!
18. Uma apresentação para guardar!
19. O palco ainda está vibrando!
20. Mais uma música, mais um grande momento!
21. A música acabou, o brilho continua!
22. Seu momento no palco foi demais!
23. Você levou essa até o fim em grande estilo!
24. Mais um sucesso no karaokê!
25. Pode soltar o aplauso!
26. O show foi seu — parabéns!
27. Que jeito bom de terminar a música!
28. Você merece esse aplauso!
29. Mais um momento inesquecível!
30. A fila espera; este aplauso é seu!
31. A música acabou, mas o microfone já está pedindo bis.
32. Última nota entregue. O microfone vai tirar uma folga.
33. O refrão terminou; agora ele pode sair da sua cabeça… talvez.
34. O palco está aplaudindo. O microfone também, mas ele é suspeito.
35. Canção concluída! Confetes virtuais ativados na imaginação.
36. Essa terminou tão bem que até o botão de avançar bateu palmas.
37. O microfone já está contando essa história para a caixa de som.
38. Fim da música: todo mundo pode respirar — inclusive o microfone.
39. O show acabou por enquanto. O microfone já está escolhendo o próximo sucesso.
40. Música concluída. A fila está pronta para o próximo capítulo musical.

---

## 4. Gerenciamento da fila

### 4.1. Adição normal — Enter

O comportamento depende do estado atual do Player:

- **Ocioso:** inicia a contagem regressiva inicial de cinco segundos; depois, inicia a música quando a contagem e as condições técnicas estiverem satisfeitas.
- **Reproduzindo:** adiciona a música ao final da fila.
- **Pausado:** adiciona a música ao final da fila, mantendo a reprodução pausada.
- **Celebração:** adiciona ao final da fila sem iniciar playback antes do fim da celebração.

### 4.2. Adição prioritária — P

A prioridade utiliza a regra:

**A última prioridade adicionada será a primeira a tocar após a música atual.**

Exemplo:

Música atual: `1001`

Fila inicial:

1. `1002`
2. `1003`

Operador digita `1111` e pressiona `P`.

Nova fila:

1. `1111` — Prioridade
2. `1002`
3. `1003`

Em seguida, digita `2222` e pressiona `P`.

Nova fila:

1. `2222` — Prioridade
2. `1111` — Prioridade
3. `1002`
4. `1003`

Regras:

- A prioridade nunca interrompe a música atual.
- Cada nova prioridade entra na primeira posição da fila pendente.
- As prioridades anteriores são deslocadas para trás.
- Se o Player estiver ocioso, `P` inicia a contagem regressiva inicial de cinco segundos.
- Se estiver pausado, a prioridade é adicionada sem retomar a reprodução.
- Durante a celebração, a prioridade é inserida na primeira posição e aguarda o fim dela.

### 4.3. Avanço e encerramento das músicas

**Término natural:**

- A música atual é retirada da sequência ativa.
- O Player exibe a celebração por aproximadamente cinco segundos.
- Ao final, inicia a próxima música conforme a fila atualizada, sem outra contagem regressiva, ou retorna ao estado ocioso se a fila estiver vazia.
- A mensagem/temporizador de transição só anuncia a próxima faixa quando houver uma música pendente.

**Avanço manual (`Ctrl + →`):**

- Encerra imediatamente a reprodução atual.
- Remove a música atual da sequência ativa.
- Inicia a próxima música disponível.
- Se não houver próxima música, o Player retorna ao estado ocioso.
- O avanço manual não é tratado como EOF natural e não inicia a celebração.
- O comando não produz EOF artificial nem pode causar avanço duplicado quando concorre com EOF natural.

`Ctrl + →` só está disponível enquanto o snapshot autoritativo e o playback confirmarem uma música efetivamente em reprodução. Fica indisponível em idle, pausa, contagem regressiva, celebração, carregamento, bloqueio/incerteza técnica ou qualquer transição não confirmada. Essa restrição não bloqueia as adições `Enter`/`P` autorizadas durante uma transição.

A fila progride de acordo com a reprodução e os comandos do operador, sem classificações adicionais ou gerenciamento de histórico.

---

## 5. Entrada de códigos

O operador digita o número da música consultando o catálogo físico.

### Comportamento

- Digitar qualquer número entre `0–9` abre automaticamente o painel de entrada.
- Os números seguintes são inseridos no mesmo painel.
- Os códigos podem conter até cinco dígitos.
- Não é necessário completar códigos com zeros à esquerda.
- `Backspace` remove o último dígito, individualmente.
- `Enter` confirma a adição normal.
- `P` confirma a adição prioritária.
- Enquanto o operador digita, modifica ou apaga um código, a UI consulta o catálogo CSV opcional por correspondência exata, sem aproximação ou confirmação por `Enter`, e atualiza Música e Artista em tempo real. Sem correspondência, os campos ficam vazios. Respostas antigas não podem sobrescrever o código atual.
- Após uma confirmação válida, o painel permanece aberto por 5 segundos sem interação, para permitir adicionar várias músicas. A interação no painel reinicia esse temporizador. No estado ocioso, a estrutura visual permanente não é ocultada: ao fim do prazo, código, Música e Artista são limpos. Durante a reprodução, o painel temporário é ocultado e a entrada é limpa, retornando à apresentação normal do vídeo.
- Quando uma música aceita tem metadados, Música e Artista continuam preenchidos na confirmação; campos vazios na captura isolada de “Música aceita” são uma omissão visual, não comportamento funcional.
- `Esc` fecha o painel e descarta a digitação atual.
- Códigos inexistentes ou vídeos indisponíveis exibem um aviso sem alterar a fila ou a reprodução.
- Feedbacks temporários de confirmação e avisos temporários de erro/rejeição duram 3,5 segundos quando esse tratamento for adequado ao design. Uma condição `blocked`/`uncertain` que precise persistir não é ocultada por esse temporizador.

### Associação com arquivos

O código utilizado pelo operador corresponde ao catálogo físico.

Exemplo:

- Código digitado: `1001`
- Arquivo de vídeo: `01001.mp4`

O Player resolve essa associação internamente, sem exigir que o operador digite zeros à esquerda.

O catálogo CSV é opcional e fornece somente metadados. Vídeos podem ser reproduzidos sem CSV. Enquanto um código é digitado, Música e Artista são preenchidos em tempo real somente quando o código atual tem correspondência exata; se o código mudar ou for apagado, o preview é atualizado, e sem correspondência os campos ficam vazios. Respostas assíncronas antigas não podem substituir os dados do código atual. Ao mostrar as informações da faixa atual com `I`, a UI exibe número, título e artista quando disponíveis; sem metadados, mostra “Dados indisponíveis” nos campos Música e Artista. A confirmação da primeira música mantém os metadados disponíveis visíveis. A ausência do CSV não impede a reprodução: a disponibilidade do vídeo físico é determinada pela biblioteca de vídeos, não pelo catálogo.

### Interface

O design visual do painel será criado e aprovado separadamente no Doop.

Esta especificação define somente o comportamento funcional, sem determinar aparência, posicionamento ou composição visual do painel.

As animações descritas nos frames aprovados são requisitos visuais e devem respeitar sua composição. Não se devem inventar animações. Se a descrição textual e as propriedades renderizadas do Doop divergirem, registrar e resolver a divergência antes da implementação. As imagens de vídeo dos frames são referências ilustrativas: a aplicação reproduz o MP4 selecionado, e a comparação visual não exige igualdade pixel a pixel com um vídeo diferente; deve avaliar principalmente overlays, painel, menus, textos, controles, mensagens, alinhamentos, proporções e composição.

---

## 6. Menu principal — Esc

O comportamento do `Esc` será contextual.

| Situação | Comportamento |
|---|---|
| Painel de informações da faixa aberto | `Esc` fecha o painel; `I` novamente renova seu temporizador de 3,5 segundos. |
| Painel numérico aberto | Fecha o painel e descarta a digitação. |
| Nenhum painel ou menu aberto | Abre o menu principal sobre a reprodução. |
| Menu principal aberto | Fecha o menu e retorna à reprodução. |
| Submenu aberto | Retorna ao nível anterior do menu. |

### 6.1. Opções iniciais

O menu principal terá três opções:

1. **Lista de comandos**
   - Exibe os comandos e atalhos disponíveis no Player Only.

2. **Opções**
   - Abre a área de configurações do Player Only.
   - Primeiro conteudo será a selecao de acervo e catalogo, novas opcoes serao adicionadas posteriormente mediante instrucao.
   - Na Fase C, inclui seleção da pasta de vídeos/acervo e configuração do catálogo CSV opcional.
   - Trata com segurança pasta válida, inválida ou vazia; CSV ausente ou com erro de leitura; alterações de configuração; e resultado de atualização do acervo. Não se devem inventar telas para estados sem referência visual aprovada; registrar a lacuna no planejamento.

3. **Sair**
   - Fecha a aplicacao, com modal de confirmacao.

Não há uma opção separada de **Voltar** no menu principal. Com ele aberto, `Esc` fecha o menu e retorna à tela de reprodução. Nos submenus, `Esc` retorna ao nível anterior, conforme a tabela acima.

### 6.2. Regras do menu

- O menu aparece sobre a tela atual.
- Abrir o menu não pausa automaticamente a reprodução.
- Caso a música já esteja pausada, permanece pausada.
- Enquanto o menu estiver aberto, os comandos de navegação do menu terão prioridade sobre os atalhos de entrada de músicas.
- O design visual do menu será definido no Doop.

---

## 7. Regras e situações especiais

| Situação | Comportamento esperado |
|---|---|
| Primeira música adicionada em idle | Inicia a contagem regressiva inicial de cinco segundos; o playback só começa depois do timer e das condições técnicas. |
| Música adicionada durante reprodução | Entra no final da fila. |
| Música adicionada durante pausa | Entra na fila sem retomar a reprodução. |
| Prioridade adicionada | Entra na primeira posição pendente. |
| Múltiplas prioridades | A última prioridade adicionada fica primeiro. |
| Música termina naturalmente | Exibe celebração por aproximadamente cinco segundos; depois inicia a próxima da fila atualizada sem outra contagem, ou retorna a idle se a fila estiver vazia. |
| Avanço manual sem próxima música | Encerra a reprodução e retorna ao estado ocioso. |
| Reiniciar música | Recomeça a música atual desde o início. |
| Reiniciar sem música ativa | Nenhuma ação. |
| Pausar sem música ativa | Nenhuma ação. |
| Backspace sem painel aberto | Nenhuma ação. |
| Código inválido | Exibe aviso sem modificar a fila. |
| Vídeo indisponível | Exibe aviso sem modificar a fila. |
| Esc durante digitação | Fecha o painel sem confirmar a música. |
| Esc sem painel aberto | Abre o menu principal. |
| Primeira música confirmada em idle | Inicia a contagem regressiva inicial de cinco segundos; o playback aguarda também as condições técnicas necessárias. |
| Espaço durante a contagem regressiva inicial | Congela o temporizador e o número; outro Espaço continua do tempo restante sem iniciar ou pausar vídeo. |
| Término natural validado | Exibe celebração por aproximadamente cinco segundos antes de decidir a próxima transição. |
| Música pendente ao fim da celebração | Inicia a primeira música da fila autoritativa sem outra contagem regressiva. |
| Fila vazia ao fim da celebração | Retorna a idle sem tela adicional nem anúncio de próxima música. |
| Enter/P durante a celebração | Atualiza a fila FIFO/LIFO; não reinicia a música encerrada e aguarda o fim da celebração. |
| Espaço durante a celebração | Congela e retoma o tempo restante sem Pause/Resume do vídeo encerrado. |
| Ctrl + → sem playback confirmado | Nenhuma ação em idle, pausa, contagem, celebração, loading, bloqueio/incerteza ou transição não confirmada. |
| Ctrl + → concorrente com EOF natural | Um único avanço; não gerar EOF artificial nem consumir duas músicas. |
| Carregamento técnico | Exibir loading somente enquanto a camada autoritativa confirmar preparação real de vídeo. |
| Informações da faixa atual (`I`) | Exibe o número e os metadados disponíveis sem alterar playback ou fila; sem metadados, mostra “Dados indisponíveis”. |
| Painel de informações da faixa | Fecha automaticamente após 3,5 segundos; `Esc` fecha antes e `I` novamente renova o prazo sem alterar playback/fila. |

---

## 8. Validação e testes

A implementação deverá validar, no mínimo:

- Entrada numérica e abertura automática do painel.
- Reconhecimento de códigos sem zeros à esquerda.
- Adição normal durante os três estados operacionais.
- Início automático quando o Player estiver ocioso.
- Adição prioritária respeitando a ordem definida.
- Pausa e continuação sem perda da posição da reprodução.
- Indicação visual de pausa.
- Avanço manual para a próxima música.
- Contagem regressiva inicial de cinco segundos, pausa/continuação pelo tempo restante e ausência de playback antes do fim e das condições técnicas.
- Celebração por aproximadamente cinco segundos somente após EOF natural; fila consultada no fim do temporizador; sem segunda contagem; pausa/continuação sem controlar vídeo encerrado.
- Adições normal/prioritária durante celebração, ordem FIFO/LIFO, fila vazia e corrida entre submissão e expiração do temporizador.
- Bloqueio de Próxima em idle, pausa, contagem, celebração, loading, transição não confirmada e playback não confirmado.
- Concorrência entre Next e EOF, sem EOF artificial nem avanço duplicado.
- Next manual não inicia a celebração pós-EOF natural.
- Loading somente durante preparação real e associado à faixa alvo autoritativa.
- Feedbacks temporários por 3,5 segundos e persistência de condições blocked/uncertain que não possam desaparecer com aviso temporário.
- Metadados presentes/ausentes: exibir título/artista somente quando fornecidos pelo catálogo opcional; playback continua possível sem CSV.
- Atualização de Música/Artista em tempo real enquanto o operador digita um código com correspondência no catálogo; respostas de outra consulta não podem substituir os metadados do código atual.
- Busca exata durante digitação, modificação e Backspace; sem correspondência, campos vazios; nunca exigir Enter nem aproximar o código; respostas assíncronas antigas ignoradas.
- `I` exibe número, Música e Artista por 3,5 segundos, ou “Dados indisponíveis” sem metadados; `Esc` fecha, novo `I` renova o prazo, sem alterar reprodução ou fila.
- Metadados disponíveis permanecem visíveis após aceitar a música; a captura sem esses campos em `PWvNA1u0Gb` registra uma omissão visual.
- Configuração de pasta e CSV, incluindo pasta válida/inválida/vazia, CSV ausente/erro de leitura, mudança de configuração e resultado de atualização da biblioteca.
- Saída confirmada/cancelada, encerramento controlado e liberação de recursos sem EOF artificial ou dano a dados/recovery.
- Reinício da música atual.
- Remoção individual de dígitos com Backspace.
- Abertura e fechamento contextual do menu com Esc.
- Tratamento de códigos inválidos e vídeos indisponíveis.
- Transições corretas entre ocioso, reproduzindo e pausado.

### Estratégia de testes

- Testes automatizados das regras de reprodução e fila.
- Testes E2E com Electron real, respeitando a arquitetura existente.
- Validação da persistência e dos estados aplicáveis.
- Testes automatizados em Linux/WSL2 e Windows, quando aplicáveis.
- Validação audiovisual e visual manual no Windows nativo.
- Conferência visual das interfaces conforme os designs aprovados no Doop.

### Definições pendentes antes das rodadas relacionadas

- A especificação ainda não define o comportamento de `Enter` e `P` durante a contagem regressiva inicial. Não substituir a faixa selecionada, enfileirar ou bloquear essas entradas por inferência; decidir antes da implementação dessa fase.
- A disponibilidade de `I` quando não há faixa atual confirmada, durante transições ou enquanto o painel numérico/menu está aberto deve seguir as referências e contratos aprovados da rodada C6; não inventar outro estado ou overlay.
- A resolução operacional de recovery `blocked`/`uncertain` não está definida. Não criar ações de replay, reset, descarte ou autoplay.
- A confirmação visual de falhas nas Opções que não tenham frame aprovado permanece pendente do plano/Doop; não criar telas adicionais por conta própria.

### Requisitos técnicos para saída e recovery

- A saída confirmada deve encerrar o playback de forma controlada, liberar recursos e preservar os dados necessários.
- O fechamento não deve produzir EOF artificial nem corromper biblioteca, catálogo ou recovery.
- A aprovação completa da resolução operacional de `blocked`/`uncertain` será feita em decisão específica antes da ativação definitiva do novo Standalone.

---

## 9. Limites da implementação

**A V1 deverá implementar exclusivamente as funcionalidades descritas neste planejamento.**

Nenhum comportamento, comando, recurso ou fluxo adicional deverá ser introduzido sem aprovação prévia.

As regras deste documento aplicam-se especificamente ao **Player Only funcionando de maneira independente (Standalone)**.

No futuro, quando o Player estiver sendo controlado por outra instância, como um Controller remoto conectado pela rede local, o comportamento operacional poderá ser diferente.

As regras desse modo remoto serão definidas em planejamento próprio e não devem alterar implicitamente o funcionamento Standalone estabelecido aqui.
