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
| Adicionar música | `Enter` | Confirma o código. Inicia a reprodução se o Player estiver ocioso; caso contrário, adiciona ao final da fila. |
| Priorizar música | `P` | Confirma o código e coloca a música na primeira posição da fila pendente, à frente das prioridades anteriores. |
| Pausar / Continuar | `Espaço` | Alterna entre pausar e continuar a reprodução atual. |
| Próxima música | `Ctrl + →` | Encerra a reprodução atual e inicia a próxima música disponível. |
| Reiniciar música | `R` | Reinicia a música atual desde o início. |
| Apagar dígito | `Backspace` | Remove o último número digitado, individualmente. |
| Abrir / Fechar menu | `Esc` | Fecha o painel numérico, quando aberto, ou abre/fecha o menu principal. |

---

## 3. Estados do Player

O Player terá três estados operacionais principais.

### 3.1. Ocioso

- Nenhuma música está sendo reproduzida.
- A fila está vazia.
- A primeira música adicionada inicia automaticamente.
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

---

## 4. Gerenciamento da fila

### 4.1. Adição normal — Enter

O comportamento depende do estado atual do Player:

- **Ocioso:** inicia imediatamente a música informada.
- **Reproduzindo:** adiciona a música ao final da fila.
- **Pausado:** adiciona a música ao final da fila, mantendo a reprodução pausada.

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
- Se o Player estiver ocioso, `P` inicia a música normalmente.
- Se estiver pausado, a prioridade é adicionada sem retomar a reprodução.

### 4.3. Avanço e encerramento das músicas

**Término natural:**

- A música atual é retirada da sequência ativa.
- A próxima música começa automaticamente.
- Se não houver próxima música, o Player retorna ao estado ocioso.

**Avanço manual (`Ctrl + →`):**

- Encerra imediatamente a reprodução atual.
- Remove a música atual da sequência ativa.
- Inicia a próxima música disponível.
- Se não houver próxima música, o Player retorna ao estado ocioso.

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
- Após uma confirmação válida, o painel se mantem aberto e some apos alguns segundos sem interacao, isso é importante caso o operador queira colocar varias musicas.
- `Esc` fecha o painel e descarta a digitação atual.
- Códigos inexistentes ou vídeos indisponíveis exibem um aviso sem alterar a fila ou a reprodução.

### Associação com arquivos

O código utilizado pelo operador corresponde ao catálogo físico.

Exemplo:

- Código digitado: `1001`
- Arquivo de vídeo: `01001.mp4`

O Player resolve essa associação internamente, sem exigir que o operador digite zeros à esquerda.

### Interface

O design visual do painel será criado e aprovado separadamente no Doop.

Esta especificação define somente o comportamento funcional, sem determinar aparência, posicionamento ou composição visual do painel.

---

## 6. Menu principal — Esc

O comportamento do `Esc` será contextual.

| Situação | Comportamento |
|---|---|
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

3. **Voltar**
   - Fecha o menu e retorna à tela de reprodução.

4. **Sair**
   - Fecha a aplicacao, com modal de confirmacao.
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
| Primeira música adicionada | Inicia automaticamente. |
| Música adicionada durante reprodução | Entra no final da fila. |
| Música adicionada durante pausa | Entra na fila sem retomar a reprodução. |
| Prioridade adicionada | Entra na primeira posição pendente. |
| Múltiplas prioridades | A última prioridade adicionada fica primeiro. |
| Música termina naturalmente | Inicia a próxima ou retorna ao estado ocioso. |
| Avanço manual sem próxima música | Encerra a reprodução e retorna ao estado ocioso. |
| Reiniciar música | Recomeça a música atual desde o início. |
| Reiniciar sem música ativa | Nenhuma ação. |
| Pausar sem música ativa | Nenhuma ação. |
| Backspace sem painel aberto | Nenhuma ação. |
| Código inválido | Exibe aviso sem modificar a fila. |
| Vídeo indisponível | Exibe aviso sem modificar a fila. |
| Esc durante digitação | Fecha o painel sem confirmar a música. |
| Esc sem painel aberto | Abre o menu principal. |

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

---

## 9. Limites da implementação

**A V1 deverá implementar exclusivamente as funcionalidades descritas neste planejamento.**

Nenhum comportamento, comando, recurso ou fluxo adicional deverá ser introduzido sem aprovação prévia.

As regras deste documento aplicam-se especificamente ao **Player Only funcionando de maneira independente (Standalone)**.

No futuro, quando o Player estiver sendo controlado por outra instância, como um Controller remoto conectado pela rede local, o comportamento operacional poderá ser diferente.

As regras desse modo remoto serão definidas em planejamento próprio e não devem alterar implicitamente o funcionamento Standalone estabelecido aqui.
