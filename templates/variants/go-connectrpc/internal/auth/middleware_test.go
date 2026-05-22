package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMiddlewareRejectsProtectedPathWithoutBearerToken(t *testing.T) {
	handler := Middleware(Config{
		Enabled:  true,
		Issuer:   "https://auth.anmho.com",
		Audience: "api://{{SERVICE_ID}}",
		JWKSURL:  "https://auth.anmho.com/api/auth/jwks",
	})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/waitlist.v1.WaitlistService/JoinWaitlist", nil))

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", response.Code)
	}
}

func TestMiddlewareLeavesHealthPublic(t *testing.T) {
	handler := Middleware(Config{Enabled: true})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	if response.Code != http.StatusNoContent {
		t.Fatalf("expected health to pass through, got %d", response.Code)
	}
}
