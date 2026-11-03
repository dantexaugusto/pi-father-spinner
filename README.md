# Pi-Father Spinner (`pi-father-spinner`)

Orquestrador persistente (**Pi-Father**) e bridge Telegram multi-instância para o agente de código **Pi** (`@earendil-works/pi-coding-agent`).

Permite que o seu agente Pi principal (conectado ao seu bot mestre do Telegram) gerencie um **Pool de Bots do Telegram** (criados no `@BotFather`) e **"spinne"** novos agentes Pi independentes em sessões `tmux` dedicadas, cada um no seu próprio diretório de projeto e janela de contexto isolada, rebatizando automaticamente o **nome de exibição (`setMyName`)** do bot no Telegram e pré-autorizando a sua conta.

---

## Principais Diferenciais

* **1 Projeto = 1 Bot no Telegram = 1 Contexto Isolado:** Cada agente filho roda em sua própria sessão `tmux` (`pi-<slug>`) e diretório (`~/projects/<slug>`), evitando poluição cruzada de contexto e reduzindo drasticamente o consumo de tokens por mensagem.
* **Spin-Up Atômico (Token + Repositório GitHub):** Envie um token do `@BotFather` e a URL de um repositório GitHub em uma única mensagem ao Pi-Father — ele cadastra o bot no pool, clona o repositório via SSH, renomeia o bot no Telegram (`setMyName`) e entrega o link `https://t.me/<bot>` pronto para uso.
* **Persistência Durável (`node:sqlite` WAL) + Auto-Recovery:** Se a VM reiniciar ou uma sessão `tmux` cair, o Pi-Father reconcilia o estado do SQLite e restaura automaticamente as sessões com `pi -c` (`--continue`), preservando todo o histórico da conversa.
* **Web Search Nativo com Tavily (`tavily_search` & `tavily_extract`):** Tanto o Pi-Father quanto todos os agentes filhos já nascem com pesquisa web em tempo real e extração de URLs via API do Tavily.
* **Skill Oficial de Tunelamento Web (`diode-tunneling`):** Todos os agentes já nascem com a skill oficial [`skills/diode-tunneling/SKILL.md`](./skills/diode-tunneling/SKILL.md) instalada globalmente (`~/.pi/agent/skills/diode-tunneling`), sabendo expor servidores locais na web com HTTPS automático via [Diode CLI](https://diode.io) sem precisar pesquisar na internet.
* **Infraestrutura 100% Automatizada (Terraform + Ansible) com Auto-Blindagem:** O Terraform provisiona a VM no AWS Lightsail e o Ansible configura o sistema, clona o repositório via Git e aplica bloqueio de escrita (`chmod a-w`) no código do orquestrador em runtime para impedir que agentes modifiquem o próprio sistema.

---

## Arquitetura do Repositório

1. **[`extensions/telegram.ts`](./extensions/telegram.ts) — Bridge Telegram Multi-Instância:**
   * Baseada na extensão oficial [`badlogic/pi-telegram`](https://github.com/badlogic/pi-telegram) (streaming nativo via `sendMessageDraft` + fallback `editMessageText`, envio/recebimento de imagens/arquivos com `telegram_attach`, `/status`, `/compact`, `/stop`).
   * **Isolamento por instância:** Suporta `PI_TELEGRAM_CONFIG=/caminho/config.json` (ou `--telegram-config`) e diretório temporário isolado por agente.
   * **Auto-Connect:** Suporta `PI_TELEGRAM_AUTOCONNECT=1` (ou `--telegram-autoconnect` / `"autoConnect": true`), iniciando o polling do Telegram automaticamente assim que a sessão `tmux` sobe.
   * **Mudança de Nome de Display (`setMyName`):** Inclui a tool `telegram_set_bot_profile`, o comando TUI `/telegram-name <novo nome>` e o comando direto no chat do Telegram `/name <novo nome>`.

2. **[`extensions/father-spinner.ts`](./extensions/father-spinner.ts) — Extensão Orquestradora do Pi-Father:**
   * Equipa o agente Pi-Father com ferramentas (`father_*`) e comandos (`/father-*`) para gerenciar o pool de bots, clonar repositórios e controlar o ciclo de vida das sessões `tmux`.
   * **Guard Automático (`PI_CHILD_AGENT=1`):** Não carrega as ferramentas de orquestração dentro dos agentes filhos, mantendo os filhos enxutos e focados no código do projeto.

3. **[`extensions/tavily.ts`](./extensions/tavily.ts) — Web Search & URL Extraction (Pai e Filhos):**
   * Registra as tools `tavily_search` e `tavily_extract` (além do comando `/tavily-status`) globalmente em `~/.pi/agent/extensions/tavily.ts`, lendo `TAVILY_API_KEY` de `~/.pi/agent/.env`.

4. **[`skills/diode-tunneling/SKILL.md`](./skills/diode-tunneling/SKILL.md) — Skill Oficial de Tunelamento Web:**
   * Segue o padrão oficial *Agent Skills* do `@earendil-works/pi-coding-agent` (`~/.pi/agent/skills/diode-tunneling/SKILL.md`), ensinando qualquer agente a criar túneis públicos/privados/protegidos para múltiplas portas locais com o Diode CLI.

5. **[`src/store.ts`](./src/store.ts) & [`src/orchestrator.ts`](./src/orchestrator.ts) — Estado Durável em SQLite + Auto-Recovery:**
   * Utiliza o `node:sqlite` nativo do Node 24 em modo **WAL** (`~/.pi/agent/father-spinner/state.sqlite`) com transações atômicas (`BEGIN IMMEDIATE`) e log de auditoria (`audit_log`).

6. **[`infra/`](./infra/) & [`infra/ansible/`](./infra/ansible/) — Provisionamento Cloud (Terraform) + Configuração (Ansible):**
   * **Terraform ([`infra/main.tf`](./infra/main.tf)):** Provisiona a instância Ubuntu 24.04 LTS no AWS Lightsail, IP Estático, Firewall e par de chaves SSH, gerando o inventário e variáveis para o Ansible.
   * **Ansible ([`infra/ansible/playbook.yml`](./infra/ansible/playbook.yml)):** Instala pacotes Linux, Node.js 24 LTS e `@earendil-works/pi-coding-agent`, configura chaves SSH/Git, clona este repositório via Git, aplica proteção contra escrita em runtime (`chmod a-w`), injeta credenciais de LLM (`deepseek.v3.2` / `kimi-k3` via Amazon Bedrock) e `TAVILY_API_KEY`, instala globalmente as extensões e skills e gerencia o serviço `systemd` **`pi-father.service`**.

---

## Como Subir na Nuvem 24/7 (AWS Lightsail + Terraform + Ansible)

### 1. Configurar variáveis (`infra/terraform.tfvars`)
Copie o arquivo de exemplo e preencha suas credenciais (Bedrock API Key, `tavily_api_key`, `father_bot_token` do `@BotFather` e seu `allowed_telegram_user_id`):

```bash
cp infra/terraform.tfvars.example infra/terraform.tfvars
```

### 2. Provisionar a Infraestrutura e Configurar a VM
```bash
make infra-init
make infra-apply
```

### 3. Atualizar Código / Configurações no Dia a Dia (via Ansible)
Depois que a VM já está criada, você pode aplicar qualquer atualização do repositório ou do `terraform.tfvars` diretamente via SSH usando o Ansible (sem precisar de sessão AWS SSO ativa):

```bash
make ansible-deploy
```

### 4. Comandos Úteis (`Makefile`)
* `make test` — Executa a suíte de testes unitários e de integração (`node:test` + SQLite + `tmux`).
* `make infra-apply` — Provisiona a infraestrutura na AWS Lightsail e executa o playbook Ansible.
* `make ansible-deploy` — Sincroniza código do GitHub, skills, extensões e variáveis na VM via Ansible.
* `make attach-father` — Abre conexão SSH direto na tela `tmux` ao vivo do `pi-father`.
* `make status` — Mostra o status do `pi-father.service` e lista todas as sessões `tmux` ativas na VM.
* `make ssh` — Abre um terminal SSH na VM.

---

## Como Iniciar Localmente (Desenvolvimento)

### Opção A: Usando o script de inicialização (em `tmux`)
```bash
./bin/pi-father.sh
```
Cria (ou anexa se já existir) a sessão `tmux` **`pi-father`** já com as extensões `telegram.ts`, `father-spinner.ts` e `tavily.ts` carregadas.

### Opção B: Instalando como pacote local no Pi
```bash
pi install .
```
Ou rodando manualmente:
```bash
pi -e .
```

---

## Ferramentas do LLM

| Tool | Escopo | O que faz |
| :--- | :--- | :--- |
| `father_spin_agent` | Pi-Father | Aloca um bot livre do pool (ou registra um novo `botToken` na hora), clona opcionalmente um repositório Git (`gitRepoUrl`), muda o **Display Name** do bot no Telegram (`setMyName`), cria a sessão `tmux` (`pi-<slug>`) e retorna o link `https://t.me/<bot_username>`. |
| `father_bot_pool` | Pi-Father | Lista os bots do pool (`list`), adiciona novo token (`add`), remove (`remove`) ou importa de arquivo JSON (`sync_file`). |
| `father_list_agents` | Pi-Father | Lista todos os agentes spinnados, status ao vivo no `tmux`, diretório (`cwd`), `@bot_username` e display name atual. |
| `father_rename_bot` | Pi-Father | Altera a qualquer momento o nome de exibição (`setMyName`) e/ou descrição curta (`setMyShortDescription`) de qualquer bot ou agente ativo. |
| `father_stop_agent` | Pi-Father | Encerra a sessão `tmux` do agente filho, devolve o bot para o pool (`available`) e reseta o display name do bot no Telegram. |
| `father_inspect_agent` | Pi-Father | Captura as últimas linhas do terminal `tmux` de um agente filho (`capture`) ou envia teclas/comandos para ele (`send_keys`). |
| `father_reconcile_agents` | Pi-Father | Reconcilia o banco SQLite com o `tmux` e recupera automaticamente sessões caídas com `pi -c`. |
| `telegram_set_bot_profile` | Pai e Filhos | Permite que qualquer agente mude seu próprio nome de exibição no Telegram (`setMyName`) quando pedido na conversa com ele. |
| `telegram_attach` | Pai e Filhos | Envia arquivos, imagens ou artefatos gerados pelo agente diretamente para o chat do Telegram. |
| `tavily_search` | Pai e Filhos | Pesquisa na web em tempo real usando a API de busca para agentes do Tavily. |
| `tavily_extract` | Pai e Filhos | Extrai conteúdo limpo em markdown/texto de até 10 URLs simultâneas via API do Tavily. |

---

## Comandos Slash (`/`)

### Na extensão `telegram.ts` (Pai e Filhos)
* `/telegram-setup` — Configura o token do bot da sessão atual.
* `/telegram-connect` / `/telegram-disconnect` — Inicia ou para o polling do Telegram.
* `/telegram-status` — Mostra o `@bot`, display name, arquivo de config e status.
* `/telegram-name <Novo Nome>` — Altera o nome de exibição do bot no Telegram (`setMyName`).
* *(Direto no chat do Telegram)*: `/status`, `/name <Novo Nome>`, `/compact`, `/stop`, `/help`.

### Na extensão `tavily.ts` (Pai e Filhos)
* `/tavily-status` — Verifica se a chave `TAVILY_API_KEY` está ativa na sessão.

### Na extensão `father-spinner.ts` (Apenas no Pi-Father)
* `/father-pool [add <token>]` — Lista os bots do pool ou adiciona um novo token.
* `/father-spin <nome-do-projeto> [Nome de Exibição]` — Spinna um novo agente Pi em `tmux` com um bot do pool.
* `/father-agents` — Lista os agentes ativos e seus bots.
* `/father-stop <nome-do-projeto>` — Para o agente, encerra o `tmux` e libera o bot no pool.
* `/father-recover` — Executa a recuperação durável de sessões `tmux` caídas.
