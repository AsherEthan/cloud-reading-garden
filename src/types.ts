export type User = {
  id: string;
  name: string;
  role: 'owner' | 'member';
  status: 'resident' | 'probation' | 'suspended';
  createdAt: string;
};
export type Participant = User & { online: boolean; hand: string | null; voice: boolean };
export type Book = { id: string; title: string; author: string; source: string };
export type Passage = { id: string; ordinal: number; body: string };
export type Note = {
  id: string;
  user_id: string;
  passage_id: string;
  body: string;
  kind: string;
  shared: number;
  author_name: string;
  created_at: string;
};
export type ReadingSession = {
  id: string;
  title: string;
  book_id: string;
  leader_id: string;
  phase: string;
  anchor_index: number;
  artifact: string;
  revision: number;
};
export type Bounty = {
  id: string;
  title: string;
  description: string;
  reward: number;
  state: string;
  claimant_id: string | null;
  claimant_name: string;
  evidence: string;
  review_note: string;
  creator_id: string;
};
export type Offer = {
  id: string;
  title: string;
  description: string;
  price: number;
  seller_id: string;
  seller_name: string;
};
export type Order = {
  id: string;
  title: string;
  price: number;
  state: string;
  buyer_id: string;
  seller_id: string;
  buyer_name: string;
  seller_name: string;
  delivery: string;
};
export type WorldPlayer = {
  id: string;
  name: string;
  x: number;
  y: number;
  facing: string;
  skin: number;
  moving: boolean;
  emote: string;
  emoteUntil: number;
};
export type AppState = {
  world: WorldPlayer[];
  user: User;
  session: ReadingSession | null;
  book: Book | null;
  passages: Passage[];
  participants: Participant[];
  books: Book[];
  notes: Note[];
  history: {
    id: string;
    title: string;
    artifact: string;
    book_title: string;
    created_at: string;
  }[];
  wallet: {
    balance: number;
    treasury: number;
    supply: number;
    transactions: { id: string; memo: string; amount: number; created_at: string }[];
    contributions: { id: string; title: string; created_at: string }[];
  };
  bounties: Bounty[];
  offers: Offer[];
  orders: Order[];
  invites: {
    id: string;
    email: string;
    expires_at: string;
    used_by: string | null;
    revoked: number;
  }[];
  members: (User & { email: string })[];
  rtc: { iceServers: RTCIceServer[]; mode: string };
};
export type Signal = {
  from: string;
  type: 'offer' | 'answer' | 'candidate';
  payload: RTCSessionDescriptionInit | RTCIceCandidateInit;
};
