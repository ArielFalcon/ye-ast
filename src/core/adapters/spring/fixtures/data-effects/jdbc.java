package shop;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.core.simple.SimpleJdbcInsert;
class Jdbc {
 private JdbcTemplate jdbc;
 private NamedParameterJdbcTemplate named;
 private SimpleJdbcInsert insert;
 void run() { jdbc.queryForObject("select count(*) from orders", Integer.class);
 named.update("delete from orders", params);
 insert.executeAndReturnKey(params);
 jdbc.getDataSource(); }
}
