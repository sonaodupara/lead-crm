# Lead Management CRM

A full-stack Lead Management CRM built with Next.js, Express.js, and MongoDB.

## Features

- Add, edit, and delete leads
- Lead status tracking (New, Contacted, Qualified, Converted, Lost)
- Search leads by name, email, or company
- Filter and sort leads
- Pagination
- Lead statistics dashboard
- Responsive design

## Tech Stack

- **Frontend:** Next.js, Tailwind CSS
- **Backend:** Node.js, Express.js
- **Database:** MongoDB Atlas

## Project Structure

lead-crm/
├── client/          # Next.js frontend
└── server/          # Express.js backend

## Setup Instructions

### Prerequisites
- Node.js 18+
- MongoDB Atlas account

### Backend Setup

```bash
cd server
npm install
```

Create `.env` file in server folder:

```env
PORT=5000
MONGODB_URI=your_mongodb_connection_string
```

```bash
npm run dev
```

Server runs on http://localhost:5000

### Frontend Setup

```bash
cd client
npm install
npm run dev
```

Frontend runs on http://localhost:3000

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/leads | Get all leads |
| POST | /api/leads | Create a lead |
| PUT | /api/leads/:id | Update a lead |
| DELETE | /api/leads/:id | Delete a lead |
| GET | /api/leads/stats | Get lead statistics |

## Live Demo

- Frontend: https://lead-crm-six-beta.vercel.app
- Backend: https://lead-crm-api.onrender.com