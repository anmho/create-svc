export const PROFILES = ["microservice", "app"] as const;

export type Profile = (typeof PROFILES)[number];

export function parseProfile(value: string): Profile {
  if (PROFILES.includes(value as Profile)) {
    return value as Profile;
  }

  throw new Error(`Unknown profile: ${value}`);
}

export function exampleForProfile(profile: Profile) {
  if (profile === "app") {
    return {
      kind: "consumer-app",
      domain: "personal-tracker",
      label: "personal tracker consumer SaaS",
    };
  }

  return {
    kind: "microservice",
    domain: "waitlist",
    label: "waitlist/launch service",
  };
}
