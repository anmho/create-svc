package vault

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
)

type AppRoleClient struct {
	addr         string
	roleIDFile   string
	secretIDFile string
	client       *http.Client

	mu    sync.Mutex
	token string
}

func NewAppRoleClient(addr string, roleIDFile string, secretIDFile string, client *http.Client) *AppRoleClient {
	return &AppRoleClient{
		addr:         strings.TrimRight(addr, "/"),
		roleIDFile:   roleIDFile,
		secretIDFile: secretIDFile,
		client:       client,
	}
}

func (c *AppRoleClient) Get(ctx context.Context, path string, key string) (string, error) {
	token, err := c.login(ctx)
	if err != nil {
		return "", err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/v1/secret/data/%s", c.addr, strings.TrimLeft(path, "/")), nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("X-Vault-Token", token)

	response, err := c.client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()

	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return "", err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("vault read failed: status=%d body=%s", response.StatusCode, strings.TrimSpace(string(raw)))
	}

	var payload struct {
		Data struct {
			Data map[string]string `json:"data"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", err
	}

	value := strings.TrimSpace(payload.Data.Data[key])
	if value == "" {
		return "", fmt.Errorf("vault secret key %q is empty", key)
	}
	return value, nil
}

func (c *AppRoleClient) login(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.token != "" {
		return c.token, nil
	}

	roleID, err := readSecretFile(c.roleIDFile)
	if err != nil {
		return "", err
	}
	secretID, err := readSecretFile(c.secretIDFile)
	if err != nil {
		return "", err
	}

	body, err := json.Marshal(map[string]string{
		"role_id":   roleID,
		"secret_id": secretID,
	})
	if err != nil {
		return "", err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.addr+"/v1/auth/approle/login", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/json")

	response, err := c.client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()

	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return "", err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("vault login failed: status=%d body=%s", response.StatusCode, strings.TrimSpace(string(raw)))
	}

	var payload struct {
		Auth struct {
			ClientToken string `json:"client_token"`
		} `json:"auth"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", err
	}

	c.token = strings.TrimSpace(payload.Auth.ClientToken)
	if c.token == "" {
		return "", fmt.Errorf("vault returned an empty client token")
	}
	return c.token, nil
}

func readSecretFile(path string) (string, error) {
	bytes, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}

	value := strings.TrimSpace(string(bytes))
	if value == "" {
		return "", fmt.Errorf("secret file %q is empty", path)
	}
	return value, nil
}
