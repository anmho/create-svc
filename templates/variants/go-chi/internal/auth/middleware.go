package auth

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

type Config struct {
	Enabled  bool
	Issuer   string
	Audience string
	JWKSURL  string
}

type jwksCache struct {
	mu        sync.Mutex
	expiresAt time.Time
	keys      []jwk
}

type jwtHeader struct {
	Alg string `json:"alg"`
	Kid string `json:"kid"`
}

type jwtClaims struct {
	Issuer    string          `json:"iss"`
	Audience  json.RawMessage `json:"aud"`
	ExpiresAt int64           `json:"exp"`
	NotBefore int64           `json:"nbf"`
}

type jwksDocument struct {
	Keys []jwk `json:"keys"`
}

type jwk struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Alg string `json:"alg"`
	N   string `json:"n"`
	E   string `json:"e"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

func Middleware(cfg Config) func(http.Handler) http.Handler {
	cache := &jwksCache{}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
			if !cfg.Enabled || publicPath(request) {
				next.ServeHTTP(w, request)
				return
			}
			token := bearerToken(request.Header.Get("Authorization"))
			if token == "" || verifyToken(request.Context(), token, cfg, cache) != nil {
				writeUnauthorized(w)
				return
			}
			next.ServeHTTP(w, request)
		})
	}
}

func publicPath(request *http.Request) bool {
	path := request.URL.Path
	return path == "/" || path == "/healthz" || path == "/readyz" || strings.HasPrefix(path, "/webhooks/")
}

func verifyToken(ctx context.Context, token string, cfg Config, cache *jwksCache) error {
	if cfg.Issuer == "" || cfg.Audience == "" || cfg.JWKSURL == "" {
		return errors.New("auth config is incomplete")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return errors.New("token must have three parts")
	}

	var header jwtHeader
	if err := decodeJSON(parts[0], &header); err != nil {
		return err
	}
	var claims jwtClaims
	if err := decodeJSON(parts[1], &claims); err != nil {
		return err
	}
	key, err := cache.key(ctx, cfg.JWKSURL, header.Kid)
	if err != nil {
		return err
	}
	if err := verifySignature(header.Alg, key, []byte(parts[0]+"."+parts[1]), parts[2]); err != nil {
		return err
	}
	return validateClaims(claims, cfg)
}

func (cache *jwksCache) key(ctx context.Context, jwksURL string, kid string) (jwk, error) {
	cache.mu.Lock()
	defer cache.mu.Unlock()

	if time.Now().After(cache.expiresAt) {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, jwksURL, nil)
		if err != nil {
			return jwk{}, err
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			return jwk{}, err
		}
		defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return jwk{}, errors.New("jwks fetch failed")
		}
		var document jwksDocument
		if err := json.NewDecoder(response.Body).Decode(&document); err != nil {
			return jwk{}, err
		}
		cache.keys = document.Keys
		cache.expiresAt = time.Now().Add(5 * time.Minute)
	}

	if kid == "" && len(cache.keys) == 1 {
		return cache.keys[0], nil
	}
	for _, key := range cache.keys {
		if key.Kid == kid {
			return key, nil
		}
	}
	return jwk{}, errors.New("jwk not found")
}

func verifySignature(alg string, key jwk, signingInput []byte, encodedSignature string) error {
	signature, err := base64.RawURLEncoding.DecodeString(encodedSignature)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(signingInput)
	switch alg {
	case "RS256":
		publicKey, err := rsaPublicKey(key)
		if err != nil {
			return err
		}
		return rsa.VerifyPKCS1v15(publicKey, crypto.SHA256, digest[:], signature)
	case "ES256":
		publicKey, err := ecdsaPublicKey(key)
		if err != nil {
			return err
		}
		if len(signature) != 64 {
			return errors.New("invalid ES256 signature")
		}
		r := new(big.Int).SetBytes(signature[:32])
		s := new(big.Int).SetBytes(signature[32:])
		if !ecdsa.Verify(publicKey, digest[:], r, s) {
			return errors.New("invalid ES256 signature")
		}
		return nil
	default:
		return errors.New("unsupported jwt alg")
	}
}

func rsaPublicKey(key jwk) (*rsa.PublicKey, error) {
	n, err := base64.RawURLEncoding.DecodeString(key.N)
	if err != nil {
		return nil, err
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(key.E)
	if err != nil {
		return nil, err
	}
	e := 0
	for _, b := range eBytes {
		e = e<<8 + int(b)
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: e}, nil
}

func ecdsaPublicKey(key jwk) (*ecdsa.PublicKey, error) {
	if key.Crv != "P-256" {
		return nil, errors.New("unsupported ecdsa curve")
	}
	x, err := base64.RawURLEncoding.DecodeString(key.X)
	if err != nil {
		return nil, err
	}
	y, err := base64.RawURLEncoding.DecodeString(key.Y)
	if err != nil {
		return nil, err
	}
	return &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}, nil
}

func validateClaims(claims jwtClaims, cfg Config) error {
	now := time.Now().Unix()
	if claims.Issuer != cfg.Issuer {
		return errors.New("issuer mismatch")
	}
	if !audienceMatches(claims.Audience, cfg.Audience) {
		return errors.New("audience mismatch")
	}
	if claims.ExpiresAt == 0 || claims.ExpiresAt <= now-30 {
		return errors.New("token expired")
	}
	if claims.NotBefore != 0 && claims.NotBefore > now+30 {
		return errors.New("token not active")
	}
	return nil
}

func audienceMatches(raw json.RawMessage, expected string) bool {
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		return single == expected
	}
	var many []string
	if err := json.Unmarshal(raw, &many); err == nil {
		for _, audience := range many {
			if audience == expected {
				return true
			}
		}
	}
	return false
}

func decodeJSON(encoded string, out any) error {
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return err
	}
	return json.Unmarshal(payload, out)
}

func bearerToken(value string) string {
	fields := strings.Fields(value)
	if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
		return ""
	}
	return fields[1]
}

func writeUnauthorized(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error": "invalid bearer token",
		"code":  "unauthorized",
	})
}
