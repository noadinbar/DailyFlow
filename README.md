<div align="center">

# 🌿 DailyFlow

### AI-powered weekly planning built around your real calendar availability.

DailyFlow brings together **calendar availability, workouts, meals, grocery planning, and stress & breaks** into one smart weekly planning experience.

[🌐 Live Demo](https://main.dnp9vhzk0bw8l.amplifyapp.com/)

<br/>

![React](https://img.shields.io/badge/React-TypeScript-61DAFB?logo=react&logoColor=white)
![AWS](https://img.shields.io/badge/AWS-Serverless-FF9900?logo=amazonaws&logoColor=white)
![Python](https://img.shields.io/badge/Backend-Python-3776AB?logo=python&logoColor=white)
![OpenAI](https://img.shields.io/badge/AI-OpenAI-412991?logo=openai&logoColor=white)
![Google Calendar](https://img.shields.io/badge/Google-Calendar-4285F4?logo=googlecalendar&logoColor=white)

</div>

---

## ✨ About DailyFlow

Recommendations are only useful if they actually fit into your real life.

**DailyFlow** combines personal preferences, Google Calendar availability, AI-generated recommendations, and deterministic scheduling rules to help users build a realistic weekly plan.

Rather than automatically changing the user's schedule, DailyFlow suggests relevant options while keeping the user in full control.

---

## 🧩 Main Features

### 📅 Smart Calendar

- Google Calendar integration
- Day, Week, and Month views
- Busy-time synchronization
- Dedicated **DailyFlow Google Calendar**
- Sunday–Saturday weekly planning
- Conflict detection across all DailyFlow activities

---

### 🏋️ Workouts

- AI-generated Workout Library
- Favorites
- Weekly Workout Plan
- Personal weekly workout goal
- Google Calendar scheduling
- Workout completion tracking
- AI-generated workout visual guides

After a workout is scheduled, DailyFlow can generate a personalized workout infographic using **`gpt-image-1-mini`**, store it in Amazon S3, and make it available directly from the workout and its Google Calendar event.

---

### 🍽️ Meals & Grocery

- AI-generated Meal Library
- Favorites
- Saved Meals This Week
- Adjustable servings
- Google Calendar scheduling
- Automatic Grocery List
- Smart ingredient grouping
- Grocery checklist
- PDF Grocery List export

DailyFlow automatically combines matching ingredients from different meals into a cleaner shopping list.

---

### 🌿 Stress & Breaks

- Personalized preferences questionnaire
- Timed and Flexible activities
- AI-generated break suggestions
- Favorites
- Weekly Break Plan
- Google Calendar scheduling
- Potentially Stressful Period detection
- Curated YouTube resources

Selected breathing, meditation, and music activities can include curated video resources that are also available from the Google Calendar event.

---

### 📊 Overview

A single view of the user's current week:

- Workout goal and scheduled workouts
- Workout completion tracking
- Scheduled meals
- Scheduled breaks
- Busy-day information
- AI-generated weekly insights
- Daily motivation

---

## 🧠 What Makes DailyFlow Smart?

DailyFlow combines **Generative AI** with **deterministic scheduling logic**.

Before anything is added to the calendar, the system checks availability against:

- 📅 Google Calendar BusyBlocks
- 🏋️ Scheduled workouts
- 🍽️ Scheduled meals
- 🌿 Scheduled breaks

This allows DailyFlow to generate recommendations that are not only personalized — but also practical.

```text
User Preferences
       +
Calendar Availability
       ↓
AI Recommendations
       ↓
Parse & Normalize
       ↓
Scheduling Validation
       ↓
Weekly Plan
       ↓
Google Calendar
