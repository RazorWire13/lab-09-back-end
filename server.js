'use strict';

// Require dependencies
const express = require('express');
const superagent = require('superagent');
const cors = require('cors');
const pg = require('pg');
const app = express();
require('dotenv').config();

// Setup DB by creating client instance, point it our DB and connect it
const client = new pg.Client(process.env.DATABASE_URL); client.connect();

client.on('error', err => console.error(err));

app.use(cors());

app.get('/location', getLocation);
app.get('/weather', getWeather);
app.get('/yelp', getYelp);
app.get('/movies', getMovies);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => console.log(`Listening on ${PORT}`));

function deleteByLocationId(table, city) {
  const SQL = `DELETE from ${table} WHERE location_id=${city};`;
  return client.query(SQL);
}

function Location(query, result) {
  this.search_query = query;
  this.formatted_query = result.body.results[0].formatted_address;
  this.latitude = result.body.results[0].geometry.location.lat;
  this.longitude = result.body.results[0].geometry.location.lng;
  this.created_at = Date.now();
}

Location.prototype = {
  save: function () {
    const SQL = `INSERT INTO locations (search_query, formatted_query, latitude, longitude) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id;`;
    const values = [this.search_query, this.formatted_query, this.latitude, this.longitude];
    return client.query(SQL, values)
      .then(result => {
        this.id = result.rows[0].id;
        return this;
      });
  }
};

Location.lookupLocation = (location) => {
  const SQL = `SELECT * FROM locations WHERE search_query=$1;`;
  const values = [location.query];

  return client.query(SQL, values)
    .then(result => {
      if (result.rowCount > 0) {
        location.cacheHit(result.rows[0]);
      } else {
        location.cacheMiss();
      }
    })
    .catch(console.error);
};



function Weather(day) {
  this.tableName = 'weathers';
  this.time = new Date(day.time * 1000).toString().slice(0, 15);
  this.forecast = day.summary;
  this.created_at = Date.now();
}

Weather.prototype = {
  save: function (location_id) {
    const SQL = `INSERT INTO ${this.tableName} (forecast, time, location_id) VALUES ($1, $2, $3, $4);`;
    const values = [this.forecast, this.time, this.created_at, location_id];
    client.query(SQL, values);
  }
};

Weather.tableName = 'weathers';
Weather.lookup = lookup;
Weather.deleteByLocationId = deleteByLocationId;

// Movies.tableName = 'movies';
// Movies.lookup = lookup;
// Movies.deleteByLocationId = deleteByLocationId;

function lookup(options) {
// Weather.lookup = (options) => {
  const SQL = `SELECT * FROM ${options.tableName} WHERE location_id=$1;`;
  const values = [options.location];

  client.query(SQL, values)
    .then(result => {
      if (result.rowCount > 0) {
        options.cacheHit(result.rows);
      } else {
        options.cacheMiss();
      }
    })
    .catch(error => handleError(error));
}

function getLocation(request, response) {
  Location.lookupLocation({
    tableName: Location.tableName,

    query: request.query.data,

    cacheHit: function(result) {
      response.send(result);
    },

    cacheMiss: function() {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${
        request.query.data}&key=${process.env.GOOGLE_API_KEY}`;
      return superagent.get(url)

        .then(result => {
          const location = new Location(request.query.data, result);
          console.log(location);


          location.save()
            .then(location => response.send(location));
        })
        .catch(error => handleError(error));
    }
  });
}


function getWeather(request, response) {
  Weather.lookup({
    tableName: Weather.tableName,

    cacheMiss: function() {
      const url = `https://api.darksky.net/forecast/${
        process.env.DARK_SKY_API_KEY}/${request.query.data.latitude},${request.query.data.longitude}`;

      superagent.get(url)
        .then(result => {
          const weatherSummaries = result.body.daily.data.map(day => {
            const summary = new Weather(day);
            summary.save(request.query.data.id);
            return summary;
          });
          response.send(weatherSummaries);

        })
        .catch(error => handleError(error, response));
    },

    cacheHit: function(resultsArray) {
      let ageOfResultsInMinutes = (Date.now() - resultsArray[0].created_at) / (1000 * 60);
      if(ageOfResultsInMinutes > 30) {
        Weather.deleteByLocationId(Weather.tableName, request.query.data.id);
        this.cacheMiss();
      } else {
        response.send(resultsArray);
      }
    }
  });
}

function getYelp(request, response) {
  const url = `https://api.yelp.com/v3/businesses/search?location=${
    request.query.data.search_query}`;
  console.log(request.query.data.search_query);

  superagent
    .get(url)
    .set('Authorization', `Bearer ${process.env.YELP_API_KEY}`)
    .then(result => {
      response.send(result.body.businesses.map(element => new Yelp(element)));
    })
    .catch(error => handleError(error, response));
}

function getMovies(request, response) {
  const url = `https://api.themoviedb.org/3/search/movie/?api_key=${
    process.env.MOVIEDB_API_KEY
  }&language=en-US&page=1&query=${request.query.data.search_query}`;
  superagent
    .get(url)
    .then(result => {
      response.send(result.body.results.map(element => new Movies(element)));
    })
    .catch(error => handleError(error, response));
}

function handleError(err, res) {
  console.error(err);
  if (res) res.status(500).send('Sorry, something went wrong');
}





function Yelp(food) {
  this.url = food.url;
  this.name = food.name;
  this.rating = food.rating;
  this.price = food.price;
  this.image_url = food.image_url;
}

function Movies(movies) {
  this.title = movies.title;
  this.released_on = movies.release_date;
  this.total_votes = movies.vote_count;
  this.average_votes = movies.vote_average;
  this.popularity = movies.popularity;
  this.image_url = movies.poster_path;
  this.overview = movies.overview;
}
