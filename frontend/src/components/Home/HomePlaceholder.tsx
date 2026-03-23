import React from 'react';

export default function HomePlaceholder(props: { username?: string }) {
  const { username } = props;

  return (
    <section className="df-card" aria-label="Home placeholder">
      <h1 className="df-title" style={{ textAlign: 'center' }}>
        Logged in successfully
      </h1>
      {username && (
        <p className="df-subtitle" style={{ textAlign: 'center' }}>
          Welcome, {username}
        </p>
      )}
    </section>
  );
}

