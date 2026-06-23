# LIS Personalize — Performance Incorporações

## Deploy no Netlify

### 1. Suba este repositório no GitHub
```
git init
git add .
git commit -m "LIS Personalize com DocuSign"
git remote add origin https://github.com/acarquitetura/lis-personalize.git
git push -u origin main
```

### 2. Conecte ao Netlify
- Acesse netlify.com → New site from Git
- Selecione o repositório lis-personalize
- Build command: (deixe vazio)
- Publish directory: .
- Clique em Deploy

### 3. Configure as variáveis de ambiente
No Netlify → Site Settings → Environment Variables, adicione:

```
DOCUSIGN_INTEGRATION_KEY = 38313e9a-0428-486c-876d-855ac0af5c81
DOCUSIGN_USER_ID         = 63f2931b-729a-428c-9273-f2c7562cf524
DOCUSIGN_ACCOUNT_ID      = 48845450
DOCUSIGN_TEMPLATE_ID     = 3a029226-7876-4734-88fc-31f5b4f0c112
DOCUSIGN_PRIVATE_KEY     = (cole a chave RSA privada completa, incluindo BEGIN e END)
```

### 4. Redeploy
Após adicionar as variáveis, clique em Trigger Deploy.

## Fluxo de assinatura
1. Cliente faz escolhas no app
2. Clica em "Confirmar personalização"
3. App chama função Netlify → cria envelope no DocuSign
4. Cliente é redirecionado para assinar no DocuSign
5. Após assinatura, volta para tela de sucesso
6. DocuSign envia automaticamente para AC Arqui (ac@amandacrespoarq.com.br)
