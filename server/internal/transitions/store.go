package transitions

import (
	"database/sql"
	"errors"

	"github.com/jota2rz/vdj-video-sync/server/internal/models"
)

// ErrSeedProtected is returned when attempting to delete a built-in effect.
var ErrSeedProtected = errors.New("built-in effects cannot be deleted")

// Store provides CRUD operations for transition CSS effects.
type Store struct {
	db *sql.DB
}

// NewStore creates a Store backed by the given database.
func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

// List returns all transition effects, optionally filtered by direction ("in" or "out").
// Pass "" to list all.
func (s *Store) List(direction string) ([]models.TransitionEffect, error) {
	var rows *sql.Rows
	var err error
	if direction != "" {
		rows, err = s.db.Query(
			"SELECT id, name, direction, css, enabled, is_seed FROM transition_effects WHERE direction = ? ORDER BY is_seed DESC, id",
			direction,
		)
	} else {
		rows, err = s.db.Query("SELECT id, name, direction, css, enabled, is_seed FROM transition_effects ORDER BY is_seed DESC, id")
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var effects []models.TransitionEffect
	for rows.Next() {
		var e models.TransitionEffect
		if err := rows.Scan(&e.ID, &e.Name, &e.Direction, &e.CSS, &e.Enabled, &e.IsSeed); err != nil {
			return nil, err
		}
		effects = append(effects, e)
	}
	return effects, rows.Err()
}

// Get returns a single transition effect by ID.
func (s *Store) Get(id int) (*models.TransitionEffect, error) {
	var e models.TransitionEffect
	err := s.db.QueryRow(
		"SELECT id, name, direction, css, enabled, is_seed FROM transition_effects WHERE id = ?", id,
	).Scan(&e.ID, &e.Name, &e.Direction, &e.CSS, &e.Enabled, &e.IsSeed)
	if err != nil {
		return nil, err
	}
	return &e, nil
}

// Create inserts a new transition effect and returns the created record.
func (s *Store) Create(name, direction, css string) (*models.TransitionEffect, error) {
	res, err := s.db.Exec(
		"INSERT INTO transition_effects (name, direction, css, enabled, is_seed) VALUES (?, ?, ?, 1, 0)",
		name, direction, css,
	)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &models.TransitionEffect{ID: int(id), Name: name, Direction: direction, CSS: css, Enabled: true, IsSeed: false}, nil
}

// Update modifies an existing transition effect.
func (s *Store) Update(id int, name, direction, css string) error {
	_, err := s.db.Exec(
		"UPDATE transition_effects SET name = ?, direction = ?, css = ? WHERE id = ?",
		name, direction, css, id,
	)
	return err
}

// SetEnabled toggles the enabled state of a transition effect.
func (s *Store) SetEnabled(id int, enabled bool) error {
	v := 0
	if enabled {
		v = 1
	}
	_, err := s.db.Exec("UPDATE transition_effects SET enabled = ? WHERE id = ?", v, id)
	return err
}

// RandomEnabled returns a random enabled effect for the given direction ("in" or "out").
// Returns nil if no enabled effects exist for that direction.
func (s *Store) RandomEnabled(direction string) (*models.TransitionEffect, error) {
	var e models.TransitionEffect
	err := s.db.QueryRow(
		"SELECT id, name, direction, css, enabled, is_seed FROM transition_effects WHERE direction = ? AND enabled = 1 ORDER BY RANDOM() LIMIT 1",
		direction,
	).Scan(&e.ID, &e.Name, &e.Direction, &e.CSS, &e.Enabled, &e.IsSeed)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return &e, nil
}

// Delete removes a transition effect by ID.
// Returns ErrSeedProtected if the effect is a built-in seed.
func (s *Store) Delete(id int) error {
	var isSeed bool
	if err := s.db.QueryRow("SELECT is_seed FROM transition_effects WHERE id = ?", id).Scan(&isSeed); err != nil {
		return err
	}
	if isSeed {
		return ErrSeedProtected
	}
	_, err := s.db.Exec("DELETE FROM transition_effects WHERE id = ?", id)
	return err
}
