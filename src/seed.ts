// Demo accounts + data so the app is explorable on first run. Log in as either
// side with the credentials below (also surfaced on the sign-in screen).
//
//   Candidate    maya@demo.test    / demo1234
//   Interviewer  priya@demo.test   / demo1234

import { createAccount } from './auth.ts';
import { postJob, saveCandidateProfile, saveEmployerProfile } from './agents.ts';
import { store } from './store.ts';
import type { Role, User } from './types.ts';

function ensureUser(email: string, password: string, role: Role, displayName: string): User {
  return store.getUserByEmail(email) ?? createAccount({ email, password, role, displayName });
}

export const DEMO = {
  candidate: { email: 'maya@demo.test', password: 'demo1234' },
  employer: { email: 'priya@demo.test', password: 'demo1234' },
};

export function seed(): { users: number; jobs: number } {
  // Interviewer side
  const priya = ensureUser(DEMO.employer.email, DEMO.employer.password, 'employer', 'Priya (Nimbus Robotics)');
  saveEmployerProfile(priya.id, {
    company: 'Nimbus Robotics',
    persona: 'warm, professional, a little proud of the team',
    voice: { name: 'employer', rate: 0.95, pitch: 0.85 },
    avatar: { emoji: '🤖', color: '#27c498' },
  });
  if (store.jobsByEmployerUser(priya.id).length === 0) {
    postJob(priya.id, {
      title: 'Senior Backend Engineer',
      salaryMin: 170000,
      salaryMax: 210000,
      visaSponsorship: true,
      remote: 'hybrid',
      location: 'San Francisco',
      requirements: ['Go', 'distributed systems', 'Kubernetes', '5+ years experience'],
      notes: [
        'The day-to-day tech stack is Go, Kubernetes, and gRPC on GCP',
        'The engineering team is 8 people; this role opens a new reliability pod',
      ],
    });
  }

  // Candidate side
  const maya = ensureUser(DEMO.candidate.email, DEMO.candidate.password, 'candidate', 'Maya');
  saveCandidateProfile(maya.id, {
    principalName: 'Maya',
    persona: 'warm and straightforward',
    voice: { name: 'maya', rate: 1.05, pitch: 1.1 },
    avatar: { emoji: '🧑‍💻', color: '#6c8cff' },
    years: 6,
    skills: ['Go', 'Kubernetes', 'distributed systems', 'PostgreSQL'],
    education: 'BS Computer Science, UT Austin',
    experience: [
      'Led the payments platform handling 2M requests/day at Flowpay',
      'Built event-driven microservices in Go with exactly-once processing',
    ],
    projects: ['ratelimit-go, an open-source token-bucket library (1.2k stars)'],
    github: 'maya-dev',
    githubVerifiedSkills: ['Go', 'Kubernetes'],
  });

  return { users: store.getUserByEmail(DEMO.candidate.email) && store.getUserByEmail(DEMO.employer.email) ? 2 : 0, jobs: store.listJobs().length };
}
